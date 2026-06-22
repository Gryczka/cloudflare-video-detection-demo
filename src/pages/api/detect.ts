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

const MODEL = '@cf/facebook/detr-resnet-50';

type Detection = {
	score: number;
	label: string;
	box: {
		xmin: number;
		ymin: number;
		xmax: number;
		ymax: number;
	};
};

const json = (body: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(body), {
		...init,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...init?.headers,
		},
	});

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

export const POST: APIRoute = async ({ request }) => {
	const contentType = request.headers.get('content-type') ?? '';

	if (!contentType.startsWith('image/')) {
		return json({ error: 'Send a raw image/* request body.' }, { status: 415 });
	}

	const { sessionId, setCookie } = getSessionId(request);
	const baseHeaders = setCookie ? { 'set-cookie': setCookie } : undefined;

	// Open-demo guardrails (bypassed entirely when PUBLIC_DEMO_MODE !== "true").
	if (isDemoMode()) {
		if (!(await checkRateLimit('detect', sessionId))) {
			recordUsage(request, 'detect', 'rate_limited', { model: MODEL });
			return blocked('demo_rate_limit', baseHeaders);
		}
		if (!(await checkDailyBudget('detect'))) {
			recordUsage(request, 'detect', 'daily_cap', { model: MODEL });
			return blocked('demo_daily_cap', baseHeaders);
		}
	}

	const image = await request.arrayBuffer();

	if (image.byteLength === 0) {
		return json({ error: 'Image body is empty.' }, { status: 400, headers: baseHeaders });
	}

	const started = Date.now();
	try {
		const detections = (await env.AI.run(MODEL, {
			image: [...new Uint8Array(image)],
		})) as Detection[];

		const inferenceMs = Date.now() - started;
		recordUsage(request, 'detect', 'success', { inferenceMs, bytes: image.byteLength, model: MODEL });

		return json(
			{ detections, inferenceMs, bytes: image.byteLength, model: MODEL },
			{ headers: baseHeaders }
		);
	} catch (error) {
		recordUsage(request, 'detect', 'error', { model: MODEL });
		return json(
			{ error: error instanceof Error ? error.message : 'Detection failed.' },
			{ status: 500, headers: baseHeaders }
		);
	}
};
