/**
 * Single source of truth for the open-demo guardrails.
 *
 * These numbers are mirrored in `wrangler.jsonc` (the `ratelimits` config and
 * the `vars` daily caps) and surfaced verbatim in the UI, so the limits we
 * disclose to users always match what is actually enforced.
 *
 * IMPORTANT: every one of these guardrails exists only because this is an
 * *open, public* demo and we want to keep Workers AI spend bounded. When you
 * deploy this project yourself (see README) and set `PUBLIC_DEMO_MODE=false`,
 * none of these limits apply.
 */
export const DEMO_LIMITS = {
	detect: {
		/** Per-browser-session calls allowed per 60s window (matches RL_DETECT). */
		perSessionPerMinute: 90,
		/** Hard global ceiling per UTC day (matches DEMO_DETECT_DAILY_CAP). */
		dailyCap: 50_000,
		/** Client sampling interval in demo mode (~1 fps continuous). */
		sampleMs: 1000,
	},
	ppe: {
		/** Per-browser-session calls allowed per 60s window (matches RL_PPE). */
		perSessionPerMinute: 6,
		/** Hard global ceiling per UTC day (matches DEMO_PPE_DAILY_CAP). */
		dailyCap: 2_000,
		/** In demo mode the expensive vision model runs as a manual single-shot. */
		manual: true,
	},
} as const;

export const SELF_HOST_FALLBACK_URL =
	'https://github.com/Gryczka/cloudflare-video-detection-demo';

export type DemoBlockReason = 'demo_rate_limit' | 'demo_daily_cap';

/** User-facing copy for a blocked request — always framed as a demo-only cutoff. */
export function demoBlockedMessage(reason: DemoBlockReason): string {
	if (reason === 'demo_daily_cap') {
		return "This open demo has reached today's global usage cap — a cost guardrail for public hosting. This limit does not exist when you deploy the project yourself.";
	}
	return "You've hit this open demo's per-session rate limit — a cost guardrail for public hosting. Wait a few seconds and try again. This limit does not exist when you deploy the project yourself.";
}
