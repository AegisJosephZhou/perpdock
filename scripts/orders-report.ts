import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Order } from '../shared/types.js';
import { currentStageSince, observedTimings, validTime } from '../server/order-observations.js';

export interface OrdersReportOptions {
  from: string; until: string; routeId?: string;
  now?: string; staleAfterMs?: number; maturityMs?: number; includeSensitive?: boolean;
}
type Cell = string | number | boolean | null;
export type OperationsRow = Record<string, Cell> & {
  orderRef: string; routeId: string; createdAt: string; status: string;
  sourceConfirmed: boolean; verifiedCompleted: boolean; matureSourceConfirmed: boolean;
  requiresAttention: boolean; queryUnavailable: boolean; stalled: boolean;
  expiredWithoutReportedSource: boolean; unreportedClientPaymentClaim: boolean;
  creationToVerifiedMs: number | null; sourceSubmissionToVerifiedMs: number | null;
  sourceConfirmationToVerifiedMs: number | null; ledgerToVerificationMs: number | null;
};

function boundary(value: string): string {
  const iso = /^\d{4}-\d\d-\d\d$/.test(value) ? `${value}T00:00:00.000Z` : value;
  if (!validTime(iso)) throw new Error('Expected a UTC day or canonical UTC timestamp.');
  return iso;
}
function reference(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 20); }
function duration(start: string | undefined, end: string | undefined): number | null {
  if (!validTime(start) || !validTime(end)) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return ms >= 0 ? ms : null;
}
function sufficientCredit(order: Order): boolean {
  const units = (s: string | undefined) => {
    if (!s || !/^\d+(\.\d{1,8})?$/.test(s)) return undefined;
    const [whole, fraction = ''] = s.split('.'); return BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  };
  const actual = units(order.creditedAmount), minimum = units(order.quote.minReceive);
  return actual !== undefined && minimum !== undefined && actual > 0n && actual >= minimum;
}
function verifiedCompletion(order: Order): boolean {
  return order.status === 'completed' && !!order.sourceTxHash && !!order.destinationTxHash
    && sufficientCredit(order) && !!order.evidence?.some(item => item.type === 'hypercore_credit'
      && item.reference.toLowerCase() === `${order.quote.recipient}:${order.destinationTxHash}`.toLowerCase());
}
function metrics(values: Array<number | null>) {
  const samples = values.filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => samples.length ? samples[Math.max(0, Math.ceil(p * samples.length) - 1)] : null;
  return { samples: samples.length, averageMs: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
}
function summary(rows: OperationsRow[]) {
  const count = (predicate: (row: OperationsRow) => boolean) => rows.filter(predicate).length;
  const confirmed = count(row => row.sourceConfirmed), complete = count(row => row.verifiedCompleted);
  const confirmedComplete = count(row => row.sourceConfirmed && row.verifiedCompleted);
  const mature = count(row => row.matureSourceConfirmed), matureComplete = count(row => row.matureSourceConfirmed && row.verifiedCompleted);
  return {
    createdOrders: rows.length, sourceReportedOrders: count(row => row.sourceReported === true), sourceConfirmedOrders: confirmed,
    verifiedCompletedOrders: complete, sourceConfirmedCompletedOrders: confirmedComplete,
    verifiedCompletedWithoutSourceTimingOrders: complete - confirmedComplete,
    observedCompletionRate: confirmed ? confirmedComplete / confirmed : null,
    matureSourceConfirmedOrders: mature, matureVerifiedCompletedOrders: matureComplete,
    matureObservedCompletionRate: mature ? matureComplete / mature : null,
    unresolvedSourceConfirmedOrders: count(row => row.sourceConfirmed && !row.verifiedCompleted),
    attentionOrders: count(row => row.requiresAttention), queryUnavailableOrders: count(row => row.queryUnavailable),
    stalledOrders: count(row => row.stalled), expiredWithoutReportedSourceOrders: count(row => row.expiredWithoutReportedSource),
    unreportedClientPaymentClaims: count(row => row.unreportedClientPaymentClaim),
    completionEvidenceMissingOrders: count(row => row.status === 'completed' && !row.verifiedCompleted),
    timingAnomalyOrders: count(row => row.timingAnomaly === true),
    durations: {
      creationToVerified: metrics(rows.filter(row => row.verifiedCompleted).map(row => row.creationToVerifiedMs)),
      sourceSubmissionToVerified: metrics(rows.filter(row => row.verifiedCompleted).map(row => row.sourceSubmissionToVerifiedMs)),
      sourceConfirmationToVerified: metrics(rows.filter(row => row.verifiedCompleted).map(row => row.sourceConfirmationToVerifiedMs)),
      ledgerToVerification: metrics(rows.filter(row => row.verifiedCompleted).map(row => row.ledgerToVerificationMs)),
    },
  };
}
function grouped(rows: OperationsRow[], key: (row: OperationsRow) => string) {
  const groups = new Map<string, OperationsRow[]>();
  for (const row of rows) { const id = key(row); groups.set(id, [...(groups.get(id) ?? []), row]); }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, values]) => ({ group, ...summary(values) }));
}
function safeOrder(value: unknown): Order {
  if (!value || typeof value !== 'object') throw new Error('Invalid order record.');
  const order = value as Order;
  if (typeof order.id !== 'string' || !validTime(order.createdAt) || !order.quote || typeof order.quote.routeId !== 'string'
    || !['awaiting_signature', 'source_pending', 'bridging', 'verifying_credit', 'completed', 'attention', 'expired'].includes(order.status)
    || !Array.isArray(order.events) || order.events.some(event => !event || typeof event.status !== 'string')) throw new Error('Invalid order record.');
  return order;
}
function makeRow(order: Order, quoteCreatedAt: string | undefined, failures: number, options: Required<Pick<OrdersReportOptions, 'now' | 'staleAfterMs' | 'maturityMs' | 'includeSensitive'>>): OperationsRow {
  const timings = observedTimings(order, quoteCreatedAt), since = currentStageSince(order), now = Date.parse(options.now);
  const completed = verifiedCompletion(order), confirmed = !!order.sourceTxHash && !!timings.sourceConfirmedObservedAt;
  const verifiedAt = completed ? timings.creditVerifiedObservedAt : undefined;
  const ledgerAt = completed ? timings.destinationLedgerAt : undefined;
  const signing = order.clientStages?.signing, broadcast = order.clientStages?.broadcast;
  const clientTime = (value: string | undefined) => validTime(value) ? value : null;
  const stageAge = order.status === 'completed' ? null : duration(since, options.now);
  const expectedTimes = [timings.quoteObservedAt, order.createdAt, timings.sourceSubmittedObservedAt, timings.sourceConfirmedObservedAt, verifiedAt].filter((value): value is string => validTime(value));
  const timingAnomaly = expectedTimes.some((value, index) => Date.parse(value) > now || index > 0 && Date.parse(value) < Date.parse(expectedTimes[index - 1]))
    || !!(signing && broadcast && Date.parse(broadcast.observedAt) < Date.parse(signing.observedAt));
  const row: OperationsRow = {
    orderRef: reference(order.id), routeId: order.quote.routeId, walletType: order.quote.transaction.kind,
    sourceChainId: order.quote.transaction.kind === 'tron' ? 'tron:mainnet' : order.quote.transaction.chainId,
    sourceChain: order.quote.sourceAsset?.chain ?? null, sourceToken: order.quote.sourceAsset?.token ?? null,
    sourceSymbol: order.quote.sourceAsset?.symbol ?? null, sourceDecimals: order.quote.sourceAsset?.decimals ?? null,
    amount: order.quote.amount, expectedReceive: order.quote.expectedReceive, minimumReceive: order.quote.minReceive,
    creditedAmount: completed ? order.creditedAmount ?? null : null, status: order.status, createdAt: order.createdAt,
    quoteObservedAt: timings.quoteObservedAt ?? null, quoteExpiresAt: order.quote.expiresAt,
    signingClientClaimAt: clientTime(signing?.observedAt), signingClaimReceivedAt: clientTime(signing?.receivedAt),
    broadcastClientClaimAt: clientTime(broadcast?.observedAt), broadcastClaimReceivedAt: clientTime(broadcast?.receivedAt),
    sourceSubmittedObservedAt: timings.sourceSubmittedObservedAt ?? null,
    sourceConfirmedObservedAt: timings.sourceConfirmedObservedAt ?? null,
    creditVerifiedObservedAt: verifiedAt ?? null, destinationLedgerAt: ledgerAt ?? null,
    currentStageSince: since ?? null, currentStageAgeMs: stageAge,
    lastCheckAttemptedAt: clientTime(order.trackingCheck?.attemptedAt), lastCheckSucceededAt: clientTime(order.trackingCheck?.succeededAt),
    lastCheckResult: order.trackingCheck?.result ?? null, pollFailures: failures,
    sourceReported: !!order.sourceTxHash, sourceConfirmed: confirmed, verifiedCompleted: completed,
    matureSourceConfirmed: confirmed && Date.parse(timings.sourceConfirmedObservedAt!) <= now - options.maturityMs,
    requiresAttention: order.status === 'attention', queryUnavailable: order.trackingCheck?.result === 'unavailable',
    stalled: !!order.sourceTxHash && order.status !== 'completed' && stageAge !== null && stageAge >= options.staleAfterMs,
    expiredWithoutReportedSource: !order.sourceTxHash && Date.parse(order.quote.expiresAt) <= now,
    unreportedClientPaymentClaim: !!broadcast && !order.sourceTxHash,
    timingAnomaly,
    creationToVerifiedMs: duration(order.createdAt, verifiedAt),
    sourceSubmissionToVerifiedMs: duration(timings.sourceSubmittedObservedAt, verifiedAt),
    sourceConfirmationToVerifiedMs: duration(timings.sourceConfirmedObservedAt, verifiedAt),
    ledgerToVerificationMs: duration(ledgerAt, verifiedAt),
  };
  if (options.includeSensitive) Object.assign(row, { orderId: order.id, sourceAddress: order.quote.sourceAddress, recipient: order.quote.recipient,
    sourceTxHash: order.sourceTxHash ?? null, destinationTxHash: order.destinationTxHash ?? null, providerOrderId: order.providerOrderId ?? null });
  return row;
}

/** Offline snapshot only. Does not instantiate Store, migrate, prune, refresh orders or contact a chain. */
export function ordersReport(path: string, options: OrdersReportOptions) {
  const from = boundary(options.from), until = boundary(options.until), now = boundary(options.now ?? new Date().toISOString());
  const staleAfterMs = options.staleAfterMs ?? 30 * 60_000, maturityMs = options.maturityMs ?? 30 * 60_000;
  if (from >= until || !Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0 || !Number.isSafeInteger(maturityMs) || maturityMs < 0) throw new Error('Invalid report window or threshold.');
  if (options.routeId !== undefined && (typeof options.routeId !== 'string' || !options.routeId || options.routeId.length > 128)) throw new Error('Invalid route filter.');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    const raw = db.prepare(`SELECT o.payload, o.poll_failures, q.created_at AS quote_created_at
      FROM orders o JOIN quotes q ON q.id=o.quote_id
      WHERE json_extract(o.payload, '$.createdAt') >= ? AND json_extract(o.payload, '$.createdAt') < ?
      ORDER BY json_extract(o.payload, '$.createdAt'), o.id`).all(from, until) as unknown as Array<{ payload: string; poll_failures: number; quote_created_at: string }>;
    const rows = raw.map(record => ({ ...record, order: safeOrder(JSON.parse(record.payload)) }))
      .filter(record => options.routeId === undefined || record.order.quote.routeId === options.routeId)
      .map(record => makeRow(record.order, record.quote_created_at, record.poll_failures, { now, staleAfterMs, maturityMs, includeSensitive: options.includeSensitive === true }));
    db.exec('COMMIT;');
    return {
      schemaVersion: 1, generatedAt: now, cohortWindowUTC: { fromInclusive: from, untilExclusive: until },
      routeFilter: options.routeId ?? null, sensitivity: options.includeSensitive ? 'private_raw_identifiers' : 'private_pseudonymous_rows',
      semantics: {
        population: 'Orders created in this UTC window, including unattributed and legacy orders; status reflects this database snapshot, not a historical as-of reconstruction.',
        successDenominator: 'Orders with a reported source transaction and server-observed source confirmation; the numerator counts only evidence-verified completions within that same cohort. Verified completions missing source timing remain separately counted. Unresolved, attention, refund reports and outages are not classified as final failures.',
        maturity: `Mature denominator requires source confirmation observed at least ${maturityMs} ms before generatedAt; it is an observation window, not a failure deadline.`,
        times: 'Server observation times include polling/indexing delays. Destination ledger time is separate. Missing legacy stages are null; updatedAt is never substituted.',
        clientClaims: 'Signing/broadcast times are untrusted browser claims. Broadcast means the browser reports a successful wallet/send-call return, never verified chain inclusion, finality or destination credit. Saving a signature alone is not this event.',
        expired: 'Expired without a reported source hash is not proof that the user did not pay; a browser claim or unknown wallet outcome requires recovery.',
        percentiles: 'Nearest-rank P50/P95 over nonnegative known durations of evidence-verified completed orders only; missing values excluded and samples reported.',
        privacy: 'Default rows omit wallet addresses, raw order/quote IDs, hashes, tokens, evidence, status messages and provider payloads. Amounts and pseudonymous order references remain private.',
        pending: 'Stalled is a review candidate using the latest financial status transition, not a failed transfer or an instruction to pay again.',
      },
      thresholds: { staleAfterMs, maturityMs }, summary: summary(rows), byRoute: grouped(rows, row => row.routeId),
      byCreatedDayUTC: grouped(rows, row => row.createdAt.slice(0, 10)), rows,
    };
  } finally { db.close(); }
}

/** Quote every cell and prefix spreadsheet formula introducers, including leading whitespace/control. */
export function ordersCsv(rows: OperationsRow[]): string {
  if (!rows.length) return 'orderRef,routeId,createdAt,status\r\n';
  const headers = Object.keys(rows[0]);
  const cell = (value: Cell | undefined) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [headers.map(cell).join(','), ...rows.map(row => headers.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
function run() {
  const args = process.argv.slice(2), values = new Map<string, string>();
  let sensitive = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--include-sensitive' && !sensitive) { sensitive = true; continue; }
    if (!['--database', '--from', '--until', '--route', '--format', '--stale-minutes', '--maturity-minutes'].includes(key) || values.has(key) || !args[index + 1]) throw new Error('Invalid arguments.');
    values.set(key, args[++index]);
  }
  if (!values.has('--database') || !values.has('--from') || !values.has('--until')) throw new Error('Database and UTC window are required.');
  const format = values.get('--format') ?? 'json';
  if (!['json', 'csv'].includes(format)) throw new Error('Invalid format.');
  const report = ordersReport(resolve(values.get('--database')!), { from: values.get('--from')!, until: values.get('--until')!,
    routeId: values.get('--route'), includeSensitive: sensitive,
    staleAfterMs: values.has('--stale-minutes') ? Number(values.get('--stale-minutes')) * 60_000 : undefined,
    maturityMs: values.has('--maturity-minutes') ? Number(values.get('--maturity-minutes')) * 60_000 : undefined });
  process.stdout.write(format === 'csv' ? ordersCsv(report.rows) : `${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); }
  catch { process.stderr.write('Orders report unavailable. Check the read-only financial backup, UTC window and options. No report was generated.\n'); process.exitCode = 1; }
}
