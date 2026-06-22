import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import {
	checkDailyBudget,
	checkRateLimit,
	getSessionId,
	isDemoMode,
	recordUsage,
} from '../../lib/usage';
import { demoBlockedMessage, type DemoBlockReason } from '../../lib/demo-limits';

export const prerender = false;

type ModelKey = 'llama' | 'llava' | 'gemma';
type TargetKey = 'hardhat' | 'baseball-cap';

type PPEAssessment = {
	person_count: number;
	persons: Array<{
		wearing_target: boolean;
		location: string;
	}>;
};

const MODELS: Record<ModelKey, string> = {
	llama: '@cf/meta/llama-3.2-11b-vision-instruct',
	llava: '@cf/llava-hf/llava-1.5-7b-hf',
	gemma: '@cf/google/gemma-4-26b-a4b-it',
};

const TARGETS: Record<TargetKey, { label: string; item: string; examples: string }> = {
	'hardhat': {
		label: 'hardhat',
		item: 'a hardhat or safety helmet',
		examples: 'construction hardhat, safety helmet, protective helmet',
	},
	'baseball-cap': {
		label: 'baseball cap',
		item: 'a baseball cap',
		examples: 'baseball cap, brimmed ball cap, casual cap',
	},
};

const systemPrompt = 'You are a construction safety vision assistant. Return only valid JSON.';
const makeUserPrompt = (target: (typeof TARGETS)[TargetKey]) => `Analyze this live video frame for headwear compliance.
Detect visible people and decide whether each person is wearing ${target.item}.
Return VALID JSON only, with no prose and no markdown fences, in exactly this shape:
{"person_count":0,"persons":[]}
If people are visible, populate persons with objects like:
{"wearing_target":true,"location":"left foreground"}
Use false when ${target.item} is not visible or cannot be confidently confirmed.
Valid positive examples include: ${target.examples}.
Do not count other headwear as compliant unless it clearly matches ${target.item}.`;

const json = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...init?.headers,
		},
	});

const runAI = (model: string, input: unknown) =>
	(env.AI.run as unknown as (model: string, input: unknown) => Promise<unknown>)(model, input);

const blocked = (reason: DemoBlockReason, headers?: HeadersInit) =>
	json(
		{
			error: demoBlockedMessage(reason),
			reason,
			demoLimit: true,
			selfHostUrl: env.SELF_HOST_URL,
		},
		{ status: 429, headers }
	);

export const POST: APIRoute = async ({ request, url }) => {
	const contentType = request.headers.get('content-type') ?? '';
	if (!contentType.startsWith('image/')) {
		return json({ error: 'Send a raw image/* request body.' }, { status: 415 });
	}

	const { sessionId, setCookie } = getSessionId(request);
	const baseHeaders = setCookie ? { 'set-cookie': setCookie } : undefined;

	// Open-demo guardrails (bypassed entirely when PUBLIC_DEMO_MODE !== "true").
	// The PPE vision model is the most expensive path, so it has the tightest
	// per-session limit and its own daily budget.
	if (isDemoMode()) {
		if (!(await checkRateLimit('ppe', sessionId))) {
			recordUsage(request, 'ppe', 'rate_limited');
			return blocked('demo_rate_limit', baseHeaders);
		}
		if (!(await checkDailyBudget('ppe'))) {
			recordUsage(request, 'ppe', 'daily_cap');
			return blocked('demo_daily_cap', baseHeaders);
		}
	}

	const requestedModel = url.searchParams.get('model') as ModelKey | null;
	const modelKey: ModelKey = requestedModel && requestedModel in MODELS ? requestedModel : 'llama';
	const requestedTarget = url.searchParams.get('target') as TargetKey | null;
	const targetKey: TargetKey = requestedTarget && requestedTarget in TARGETS ? requestedTarget : 'hardhat';
	const target = TARGETS[targetKey];
	const model = MODELS[modelKey];
	const image = await request.arrayBuffer();

	if (image.byteLength === 0) {
		return json({ error: 'Image body is empty.' }, { status: 400, headers: baseHeaders });
	}

	const imageBytes = [...new Uint8Array(image)];
	const imageDataUrl = `data:${contentType};base64,${arrayBufferToBase64(image)}`;
	const started = Date.now();

	try {
		const rawResult = await runPPEModel(modelKey, model, imageBytes, imageDataUrl, makeUserPrompt(target));
		const raw = extractText(rawResult);
		const assessment = parseAssessment(raw);
		const inferenceMs = Date.now() - started;

		recordUsage(request, 'ppe', 'success', { inferenceMs, bytes: image.byteLength, model });

		return json(
			{
				assessment,
				raw,
				inferenceMs,
				bytes: image.byteLength,
				model,
				modelKey,
				targetKey,
				target: target.label,
			},
			{ headers: baseHeaders }
		);
	} catch (error) {
		recordUsage(request, 'ppe', 'error', { model });
		return json(
			{
				error: error instanceof Error ? error.message : 'PPE assessment failed.',
				model,
				modelKey,
				targetKey,
			},
			{ status: 500, headers: baseHeaders }
		);
	}
};

async function runPPEModel(
	modelKey: ModelKey,
	model: string,
	imageBytes: number[],
	imageDataUrl: string,
	userPrompt: string
) {
	if (modelKey === 'llava') {
		return runAI(model, {
			image: imageBytes,
			prompt: `${systemPrompt}\n${userPrompt}`,
			max_tokens: 512,
		});
	}

	const input = {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
		image: imageDataUrl,
	};

	if (modelKey === 'llama') {
		try {
			return await runAI(model, input);
		} catch (error) {
			if (!isLicenseAgreementError(error)) throw error;
			await runAI(model, { prompt: 'agree' });
			return runAI(model, input);
		}
	}

	return runAI(model, input);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function extractText(result: unknown): string {
	if (typeof result === 'string') return result;
	if (!result || typeof result !== 'object') return '';
	const record = result as Record<string, unknown>;
	for (const key of ['response', 'description', 'text', 'result']) {
		if (typeof record[key] === 'string') return record[key] as string;
		if (record[key] && typeof record[key] === 'object') return JSON.stringify(record[key]);
	}
	const choices = record.choices;
	if (Array.isArray(choices)) {
		const first = choices[0] as Record<string, unknown> | undefined;
		const message = first?.message as Record<string, unknown> | undefined;
		if (typeof message?.content === 'string') return message.content;
		if (typeof first?.text === 'string') return first.text;
	}
	return JSON.stringify(result);
}

function parseAssessment(raw: string): PPEAssessment | null {
	const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
	const match = cleaned.match(/\{[\s\S]*\}/);
	if (!match) return null;

	try {
		const parsed = findAssessment(JSON.parse(match[0]));
		if (!parsed) return null;
		return {
			person_count: Math.max(0, Math.round(Number(parsed.person_count))),
			persons: parsed.persons.map((person) => ({
				wearing_target: Boolean(person?.wearing_target ?? person?.wearing_hardhat),
				location: typeof person?.location === 'string' ? person.location : 'visible person',
			})),
		};
	} catch {
		return null;
	}
}

function findAssessment(value: unknown): Partial<PPEAssessment> | null {
	if (!value || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;

	if (Number.isFinite(record.person_count) && Array.isArray(record.persons)) {
		return record as Partial<PPEAssessment>;
	}

	for (const key of ['response', 'assessment', 'result']) {
		const nested = findAssessment(record[key]);
		if (nested) return nested;
	}

	return null;
}

function isLicenseAgreementError(error: unknown) {
	const message = String(error instanceof Error ? error.message : error).toLowerCase();
	return message.includes('agree') || message.includes('license') || message.includes('acceptable use');
}
