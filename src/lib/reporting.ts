/**
 * Usage reporting for the open public demo.
 *
 * Runs from the Worker's `scheduled()` handler (see src/worker.ts):
 *   - runMonthlyReport     -> always emails a prior-month usage summary,
 *                             escalating the subject to [ALERT] over threshold.
 *   - runDailySpikeAlert   -> emails ONLY when the prior day's total inferences
 *                             breach DAILY_SPIKE_THRESHOLD (early runaway warning).
 *
 * Data comes from the Analytics Engine SQL API. Everything is best-effort: if
 * the SQL token or email binding is missing, we log and return rather than throw.
 */

const DATASET = 'video_detection_usage';

type SqlRow = Record<string, string | number | null>;

/** Minimal shape of the Cloudflare Email Service binding's structured send(). */
type EmailSender = {
	send(message: {
		to: string | string[];
		from: { email: string; name?: string };
		subject: string;
		html: string;
		text: string;
	}): Promise<unknown>;
};

function envStr(env: Env, key: string): string | undefined {
	const value = (env as unknown as Record<string, unknown>)[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

async function querySql(env: Env, sql: string): Promise<SqlRow[]> {
	const token = envStr(env, 'AE_SQL_API_TOKEN');
	const account = envStr(env, 'CF_ACCOUNT_ID');
	if (!token || !account) {
		throw new Error('Analytics Engine SQL API not configured (need AE_SQL_API_TOKEN + CF_ACCOUNT_ID).');
	}
	const resp = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
		{
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: sql,
		}
	);
	if (!resp.ok) {
		throw new Error(`Analytics Engine SQL API ${resp.status}: ${await resp.text()}`);
	}
	const payload = (await resp.json()) as { data?: SqlRow[] };
	return payload.data ?? [];
}

function fmtTs(date: Date): string {
	return date.toISOString().slice(0, 19).replace('T', ' ');
}

function num(value: string | number | null | undefined): number {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

async function sendEmail(env: Env, subject: string, html: string, text: string): Promise<void> {
	const binding = (env as unknown as { EMAIL?: EmailSender }).EMAIL;
	const to = envStr(env, 'REPORT_EMAIL_TO');
	const from = envStr(env, 'REPORT_EMAIL_FROM');
	if (!binding || !to || !from) {
		console.warn('[reporting] email not configured (EMAIL binding / REPORT_EMAIL_TO / REPORT_EMAIL_FROM); skipping send.');
		return;
	}
	await binding.send({
		to,
		from: { email: from, name: 'Video Detection Demo' },
		subject,
		html,
		text,
	});
}

// --- Monthly summary -------------------------------------------------------

export async function runMonthlyReport(env: Env): Promise<void> {
	const now = new Date();
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
	const range = `timestamp >= '${fmtTs(start)}' AND timestamp < '${fmtTs(end)}'`;
	const monthLabel = start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

	try {
		const [byEndpoint, byOutcome, byCountry, byDay] = await Promise.all([
			querySql(env, `SELECT blob1 AS endpoint, SUM(_sample_interval) AS n, SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_ms FROM ${DATASET} WHERE ${range} GROUP BY endpoint ORDER BY n DESC`),
			querySql(env, `SELECT blob6 AS outcome, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${range} GROUP BY outcome ORDER BY n DESC`),
			querySql(env, `SELECT blob2 AS country, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${range} GROUP BY country ORDER BY n DESC LIMIT 10`),
			querySql(env, `SELECT toDate(timestamp) AS day, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${range} GROUP BY day ORDER BY day`),
		]);

		const total = byEndpoint.reduce((sum, r) => sum + num(r.n), 0);
		const threshold = num(envStr(env, 'USAGE_ALERT_THRESHOLD'));
		const over = threshold > 0 && total > threshold;
		const subject = `${over ? '[ALERT] ' : ''}Video Detection demo — ${monthLabel}: ${total.toLocaleString()} inferences`;

		const { html, text } = buildReport({
			heading: `Monthly usage — ${monthLabel}`,
			total,
			threshold,
			over,
			thresholdLabel: 'monthly alert threshold',
			byEndpoint,
			byOutcome,
			byCountry,
			byDay,
		});
		await sendEmail(env, subject, html, text);
		console.log(`[reporting] monthly report sent: ${total} inferences (${monthLabel}).`);
	} catch (error) {
		console.error('[reporting] monthly report failed:', error instanceof Error ? error.message : error);
	}
}

// --- Daily spike alert -----------------------------------------------------

export async function runDailySpikeAlert(env: Env): Promise<void> {
	const now = new Date();
	const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
	const range = `timestamp >= '${fmtTs(start)}' AND timestamp < '${fmtTs(end)}'`;
	const dayLabel = start.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

	try {
		const threshold = num(envStr(env, 'DAILY_SPIKE_THRESHOLD'));
		if (threshold <= 0) return;

		const [byEndpoint, byCountry] = await Promise.all([
			querySql(env, `SELECT blob1 AS endpoint, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${range} GROUP BY endpoint ORDER BY n DESC`),
			querySql(env, `SELECT blob2 AS country, SUM(_sample_interval) AS n FROM ${DATASET} WHERE ${range} GROUP BY country ORDER BY n DESC LIMIT 10`),
		]);
		const total = byEndpoint.reduce((sum, r) => sum + num(r.n), 0);

		if (total <= threshold) {
			console.log(`[reporting] daily spike check: ${total} <= ${threshold}, no alert for ${dayLabel}.`);
			return;
		}

		const subject = `[ALERT] Video Detection demo daily spike — ${dayLabel}: ${total.toLocaleString()} inferences`;
		const { html, text } = buildReport({
			heading: `Daily spike alert — ${dayLabel}`,
			total,
			threshold,
			over: true,
			thresholdLabel: 'daily spike threshold',
			byEndpoint,
			byOutcome: [],
			byCountry,
			byDay: [],
		});
		await sendEmail(env, subject, html, text);
		console.log(`[reporting] daily spike alert sent: ${total} inferences (${dayLabel}).`);
	} catch (error) {
		console.error('[reporting] daily spike alert failed:', error instanceof Error ? error.message : error);
	}
}

// --- Email composition -----------------------------------------------------

function buildReport(data: {
	heading: string;
	total: number;
	threshold: number;
	over: boolean;
	thresholdLabel: string;
	byEndpoint: SqlRow[];
	byOutcome: SqlRow[];
	byCountry: SqlRow[];
	byDay: SqlRow[];
}): { html: string; text: string } {
	const { heading, total, threshold, over, thresholdLabel, byEndpoint, byOutcome, byCountry, byDay } = data;

	const rows = (items: SqlRow[], key: string) =>
		items.map((r) => `${String(r[key] ?? '—')}: ${num(r.n).toLocaleString()}`);

	const endpointLines = rows(byEndpoint, 'endpoint');
	const outcomeLines = rows(byOutcome, 'outcome');
	const countryLines = rows(byCountry, 'country');
	const dayLines = byDay.map((r) => `${String(r.day ?? '—')}: ${num(r.n).toLocaleString()}`);

	const banner = over
		? `<p style="margin:0 0 16px;padding:12px 16px;background:#fde8e8;border:1px solid #f5b5b5;border-radius:8px;color:#8a1c1c;font-weight:600;">⚠ Usage exceeded the ${thresholdLabel} of ${threshold.toLocaleString()} inferences.</p>`
		: `<p style="margin:0 0 16px;padding:12px 16px;background:#e8f5ec;border:1px solid #a8d8b9;border-radius:8px;color:#1c6b35;">Within the ${thresholdLabel} (${threshold.toLocaleString()}).</p>`;

	const section = (title: string, lines: string[]) =>
		lines.length
			? `<h3 style="margin:20px 0 8px;font-size:15px;color:#111;">${title}</h3><ul style="margin:0;padding-left:18px;color:#333;font-size:14px;line-height:1.6;">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`
			: '';

	const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:640px;margin:0 auto;padding:24px;">
<div style="background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:24px;">
<h2 style="margin:0 0 4px;font-size:20px;color:#111;">${heading}</h2>
<p style="margin:0 0 16px;color:#666;font-size:13px;">Cloudflare Workers AI — open public demo usage report</p>
${banner}
<p style="margin:0 0 8px;font-size:28px;font-weight:700;color:#f6821f;">${total.toLocaleString()}<span style="font-size:14px;font-weight:400;color:#666;"> total inferences</span></p>
${section('By view', endpointLines)}
${section('By outcome', outcomeLines)}
${section('Top countries', countryLines)}
${section('Daily trend', dayLines)}
<p style="margin:24px 0 0;color:#999;font-size:12px;">Sent automatically by the video-detection demo Worker. Adjust thresholds and caps in wrangler.jsonc.</p>
</div></div></body></html>`;

	const textParts = [
		heading,
		'',
		over ? `ALERT: exceeded ${thresholdLabel} of ${threshold.toLocaleString()}.` : `Within ${thresholdLabel} (${threshold.toLocaleString()}).`,
		'',
		`Total inferences: ${total.toLocaleString()}`,
	];
	const textSection = (title: string, lines: string[]) => {
		if (!lines.length) return;
		textParts.push('', `${title}:`, ...lines.map((l) => `  ${l}`));
	};
	textSection('By view', endpointLines);
	textSection('By outcome', outcomeLines);
	textSection('Top countries', countryLines);
	textSection('Daily trend', dayLines);

	return { html, text: textParts.join('\n') };
}
