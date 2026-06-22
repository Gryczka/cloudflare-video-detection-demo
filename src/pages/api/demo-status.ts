import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { isDemoMode } from '../../lib/usage';
import { DEMO_LIMITS, SELF_HOST_FALLBACK_URL } from '../../lib/demo-limits';

export const prerender = false;

/**
 * Lightweight runtime config for the client. Because the demo pages are
 * statically prerendered, the browser reads this at load time to decide whether
 * to show the open-demo banner and whether the expensive PPE view should run as
 * a manual single-shot (demo) or a continuous loop (self-hosted / production).
 */
export const GET: APIRoute = () => {
	const demoMode = isDemoMode();
	return new Response(
		JSON.stringify({
			demoMode,
			selfHostUrl: env.SELF_HOST_URL ?? SELF_HOST_FALLBACK_URL,
			detect: {
				sampleMs: DEMO_LIMITS.detect.sampleMs,
				perSessionPerMinute: DEMO_LIMITS.detect.perSessionPerMinute,
				dailyCap: DEMO_LIMITS.detect.dailyCap,
			},
			ppe: {
				// Manual single-shot only applies in demo mode; self-host runs continuous.
				manual: demoMode && DEMO_LIMITS.ppe.manual,
				perSessionPerMinute: DEMO_LIMITS.ppe.perSessionPerMinute,
				dailyCap: DEMO_LIMITS.ppe.dailyCap,
			},
		}),
		{
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'cache-control': 'no-store',
			},
		}
	);
};
