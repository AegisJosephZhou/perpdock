import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

function isoDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid UTC day.');
  }
  return `${value}T00:00:00.000Z`;
}

/** Offline, read-only, aggregated output. Never opens the financial store. */
export function attributionReport(path: string, fromDay: string, untilDay: string) {
  const from = isoDay(fromDay), until = isoDay(untilDay);
  if (from >= until) throw new Error('The cohort window must have a positive length.');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const cohort = db.prepare(`
      SELECT substr(s.first_seen_at, 1, 10) AS cohort_date_utc,
        s.campaign, s.source, s.medium, s.lang,
        COUNT(DISTINCT s.session_id) AS attributed_sessions,
        COUNT(DISTINCT CASE WHEN s.landing_at IS NOT NULL THEN s.session_id END) AS observed_landing_sessions,
        COUNT(DISTINCT CASE WHEN s.landing_at IS NULL THEN s.session_id END) AS missing_landing_sessions,
        COUNT(DISTINCT CASE WHEN q.quote_id IS NOT NULL THEN s.session_id END) AS quoted_sessions,
        COUNT(DISTINCT q.quote_id) AS successful_quotes,
        COUNT(DISTINCT o.order_id) AS created_orders,
        COUNT(DISTINCT CASE WHEN o.source_confirmed_at IS NOT NULL THEN o.order_id END) AS source_confirmed_orders,
        COUNT(DISTINCT CASE WHEN o.completed_at IS NOT NULL THEN o.order_id END) AS verified_completed_orders,
        COUNT(DISTINCT CASE WHEN o.completed_at IS NOT NULL THEN s.session_id END) AS sessions_with_completed_orders
      FROM attribution_sessions s
      LEFT JOIN attribution_quotes q ON q.session_id=s.session_id
      LEFT JOIN attribution_orders o ON o.quote_id=q.quote_id
      WHERE s.first_seen_at >= ? AND s.first_seen_at < ?
        AND s.campaign NOT GLOB 'test_*' AND s.campaign NOT GLOB 'internal_*'
      GROUP BY cohort_date_utc, s.campaign, s.source, s.medium, s.lang
      ORDER BY cohort_date_utc, s.campaign, s.source, s.medium, s.lang
    `).all(from, until);
    const capacityDrops = db.prepare(`SELECT name, count FROM attribution_counters
      WHERE name IN ('capacity_dropped_sessions', 'capacity_dropped_quotes', 'capacity_dropped_orders') ORDER BY name`).all();
    db.exec('COMMIT;');
    return {
      status: cohort.length ? 'attributed_data' : 'no_attributed_sessions',
      generatedAt: new Date().toISOString(),
      cohortWindowUTC: { fromInclusive: from, untilExclusive: until },
      semantics: {
        attributedOnly: true,
        stages: 'First-observed session cohort; later verified stages as of this read, not event-day conversion rates.',
        identity: 'Random tab sessions and client-supplied campaign labels; not verified people, customers, or causal attribution.',
        exclusions: ['unattributed and legacy orders', 'test_* campaigns', 'internal_* campaigns'],
        coverage: 'Best effort, 30-day retention; blocked requests, disabled collection, capacity drops, and collector failures can omit data. No rows does not mean no product usage.',
        financials: 'No revenue, fees, amounts, CAC, or LTV are measured.',
      },
      cohort,
      capacityDropsSinceDatabaseCreation: capacityDrops,
    };
  } finally { db.close(); }
}

function run(): void {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--database', '--from', '--until'].includes(key) || !value || values.has(key)) throw new Error('Invalid arguments.');
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error('Expected --database, --from and --until.');
  const report = attributionReport(resolve(values.get('--database')!), values.get('--from')!, values.get('--until')!);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); }
  catch {
    // Do not leak local paths, raw rows, credentials, or SQLite exception details.
    process.stderr.write('Attribution report unavailable. Check the read-only analytics database and UTC date arguments.\n');
    process.exitCode = 1;
  }
}
