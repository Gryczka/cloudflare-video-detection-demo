/**
 * Server-side helpers for the open-demo guardrails and usage analytics.
 *
 * Every enforcement path here is a no-op when `PUBLIC_DEMO_MODE !== "true"`
 * (self-hosted / production) and degrades gracefully if a binding is missing,
 * so a fresh `git clone && npm run dev` works without provisioning anything.
 */
import { env } from 'cloudflare:workers';
import { DEMO_LIMITS } from './demo-limits';

export type Endpoint = 'detect' | 'ppe';
export type Outcome = 'success' | 'error' | 'rate_limited' | 'daily_cap';

const COOKIE_NAME = 'vdd_sid';

/** Demo mode is ON by default; only an explicit "false" turns it off. */
export function isDemoMode(): boolean {
	return (env.PUBLIC_DEMO_MODE as string) !== 'false';
}

/**
 * Read (or mint) the per-browser session id used as the rate-limit key.
 * Returns a `setCookie` string when a new id was generated so the caller can
 * attach it to the response.
 */
export function getSessionId(request: Request): { sessionId: string; setCookie?: string } {
	const cookie = request.headers.get('cookie') ?? '';
	const match = cookie.match(/(?:^|;\s*)vdd_sid=([^;]+)/);
	if (match) return { sessionId: decodeURIComponent(match[1]) };

	const sessionId = crypto.randomUUID();
	const setCookie = `${COOKIE_NAME}=${sessionId}; Path=/; Max-Age=86400; SameSite=Lax; Secure`;
	return { sessionId, setCookie };
}

/** Per-session rate limit. Returns true when the request is allowed. */
export async function checkRateLimit(endpoint: Endpoint, sessionId: string): Promise<boolean> {
	const limiter = endpoint === 'detect' ? env.RL_DETECT : env.RL_PPE;
	if (!limiter) return true; // binding not configured -> allow
	const { success } = await limiter.limit({ key: `${endpoint}:${sessionId}` });
	return success;
}

/**
 * Hard global daily budget cap. Funnels every inference through a single
 * BudgetCounter Durable Object instance so the per-UTC-day ceiling is exact and
 * global. Returns true when the request is within budget.
 */
export async function checkDailyBudget(endpoint: Endpoint): Promise<boolean> {
	if (!env.BUDGET) return true; // binding not configured -> allow
	const vars = env as unknown as Record<string, string | undefined>;
	const cap =
		endpoint === 'detect'
			? Number(vars.DEMO_DETECT_DAILY_CAP ?? DEMO_LIMITS.detect.dailyCap)
			: Number(vars.DEMO_PPE_DAILY_CAP ?? DEMO_LIMITS.ppe.dailyCap);

	const stub = env.BUDGET.get(env.BUDGET.idFromName('global'));
	const result = await stub.consume(endpoint, cap);
	return result.allowed;
}

/** Best-effort: write one Analytics Engine data point per inference. */
export function recordUsage(
	request: Request,
	endpoint: Endpoint,
	outcome: Outcome,
	opts: { inferenceMs?: number; bytes?: number; model?: string } = {}
): void {
	if (!env.ANALYTICS) return;
	const cf = (request as Request & { cf?: IncomingRequestCfProperties }).cf;
	try {
		env.ANALYTICS.writeDataPoint({
			indexes: [endpoint],
			blobs: [
				endpoint,
				String(cf?.country ?? 'XX'),
				String(cf?.colo ?? '??'),
				String(cf?.city ?? ''),
				opts.model ?? '',
				outcome,
			],
			doubles: [opts.inferenceMs ?? 0, opts.bytes ?? 0],
		});
	} catch {
		// Analytics is observability only — never fail a response because of it.
	}
}
