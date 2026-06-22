/**
 * Custom Worker entrypoint (Astro 6 / @astrojs/cloudflare v13).
 *
 * Wraps Astro's `handle()` fetch handler so we can additionally export:
 *   - the BudgetCounter Durable Object (global daily spend cap), and
 *   - a `scheduled()` cron handler that emails usage reports.
 *
 * Configured via `"main": "./src/worker.ts"` in wrangler.jsonc.
 */
import { handle } from '@astrojs/cloudflare/handler';
import { DurableObject } from 'cloudflare:workers';
import { runDailySpikeAlert, runMonthlyReport } from './lib/reporting';

/**
 * Global, strongly-consistent daily inference budget.
 *
 * All requests funnel through a single instance ("global"), so the per-UTC-day
 * per-endpoint counts are exact regardless of which Cloudflare location served
 * the request. Durable Object input gates make the get-then-put atomic.
 */
export class BudgetCounter extends DurableObject<Env> {
	async consume(
		endpoint: 'detect' | 'ppe',
		cap: number
	): Promise<{ allowed: boolean; count: number; cap: number }> {
		const day = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
		const key = `${day}:${endpoint}`;
		const current = (await this.ctx.storage.get<number>(key)) ?? 0;
		if (current >= cap) {
			return { allowed: false, count: current, cap };
		}
		const next = current + 1;
		await this.ctx.storage.put(key, next);
		return { allowed: true, count: next, cap };
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		return handle(request, env, ctx);
	},

	async scheduled(controller, env, ctx): Promise<void> {
		switch (controller.cron) {
			case '0 14 1 * *': // monthly summary (1st of month, 14:00 UTC)
				ctx.waitUntil(runMonthlyReport(env));
				break;
			case '0 14 * * *': // daily spike alert (14:00 UTC daily)
				ctx.waitUntil(runDailySpikeAlert(env));
				break;
		}
	},
} satisfies ExportedHandler<Env>;
