import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new Error('Invalid UTC day.');
  return `${value}T00:00:00.000Z`;
}
/** Offline aggregate only. It never reads financial storage, credentials or request logs. */
export function funnelReport(path: string, fromDay: string, untilDay: string) {
  const from = day(fromDay), until = day(untilDay);
  if (from >= until) throw new Error('Expected positive cohort window.');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const cohorts = db.prepare(`SELECT substr(first_seen_at,1,10) AS cohort_date_utc, lang, COUNT(*) AS sessions
      FROM funnel_sessions WHERE first_seen_at>=? AND first_seen_at<? GROUP BY cohort_date_utc,lang ORDER BY cohort_date_utc,lang`).all(from, until);
    const stages = db.prepare(`SELECT substr(s.first_seen_at,1,10) AS cohort_date_utc,s.lang,e.event,e.authority,
      COUNT(*) AS observations,COUNT(DISTINCT e.session_id) AS sessions,
      COUNT(DISTINCT e.quote_id) AS linked_quotes,COUNT(DISTINCT e.order_id) AS linked_orders
      FROM funnel_sessions s JOIN funnel_events e USING(session_id)
      WHERE s.first_seen_at>=? AND s.first_seen_at<? GROUP BY cohort_date_utc,s.lang,e.event,e.authority
      ORDER BY cohort_date_utc,s.lang,e.event,e.authority`).all(from, until);
    const delivery = db.prepare('SELECT delivery,COUNT(*) AS observations FROM funnel_events GROUP BY delivery ORDER BY delivery').all();
    const drops = db.prepare('SELECT name,count FROM funnel_counters ORDER BY name').all();
    db.exec('COMMIT');
    return {
      status: cohorts.length ? 'observed_funnel_data' : 'no_observed_sessions',
      generatedAt: new Date().toISOString(), cohortWindowUTC: { fromInclusive: from, untilExclusive: until },
      semantics: {
        identity: 'Random 30-minute tab sessions, including traffic without UTM; not verified people or customers.',
        stages: 'Session first-observed cohort with stages known at report time; not event-day rates. A stage may be missing.',
        authority: 'client is unverified UI observation; authenticated_client is an authorized order declaration received by server; server is committed API/verification evidence.',
        completion: 'Only server credit_verified counts verified completion. Broadcast/reference observations are not funds confirmation.',
        attempts: 'Client attempt errors may also have a server failure; do not add them together. Server quote and order outcomes are authoritative.',
        coverage: 'Optional best effort collector, 30-day retention and hard capacity; missing rows do not imply zero usage. No retroactive backfill.',
        attribution: 'Independent of approved-UTM attribution. Never sum the two collectors as additional sessions or orders.',
        financials: 'No addresses, amounts, hashes, access tokens, revenue, fees or personal identities are reported.',
      },
      cohorts, stages, deliveryAllRetainedEvents: delivery, dropsSinceDatabaseCreation: drops,
    };
  } finally { db.close(); }
}

function run(): void {
  const args = process.argv.slice(2), values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--database', '--from', '--until'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('Invalid arguments.');
    values.set(args[i], args[i + 1]);
  }
  if (values.size !== 3) throw new Error('Expected database and UTC dates.');
  process.stdout.write(`${JSON.stringify(funnelReport(resolve(values.get('--database')!), values.get('--from')!, values.get('--until')!), null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); }
  catch { process.stderr.write('Funnel report unavailable. Check the read-only analytics database and UTC dates.\n'); process.exitCode = 1; }
}
