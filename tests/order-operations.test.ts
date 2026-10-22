import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Order, ProviderAdapter, ProviderQuote, QuoteRequest, TrackingUpdate } from '../shared/types.js';
import { OrderService, type FundingObserver } from '../server/order-service.js';
import { Store } from '../server/store.js';
import { findPerpsCredit } from '../server/chain/hyperliquid.js';
import { ordersCsv, ordersReport } from '../scripts/orders-report.js';

const start = Date.UTC(2026, 9, 22, 12), iso = (offset = 0) => new Date(start + offset).toISOString();
const source = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`, destination = `0x${'b'.repeat(64)}`;
const secret = 'TEST_ONLY_order_operations_secret_01234567890123456789';
const input: QuoteRequest = { routeId: 'test-usdc', amount: '100', sourceAddress: source, recipient };
const event1 = '11111111-1111-4111-8111-111111111111', event2 = '22222222-2222-4222-8222-222222222222';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function setup(observer?: FundingObserver, onTrackingUnavailable?: (routeId: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'order-ops-test-')), path = join(dir, 'funding.sqlite');
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  let now = start;
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [{ id: input.routeId, label: 'TEST ONLY', sourceChain: 'Arbitrum', sourceChainId: 42161,
      sourceToken: `0x${'3'.repeat(40)}`, symbol: 'USDC', decimals: 6, walletType: 'evm' as const, available: true }]),
    getQuote: vi.fn(async (request: QuoteRequest): Promise<ProviderQuote> => ({ ...request, amountBaseUnits: '100000000', expectedReceive: '99', minReceive: '98',
      expiresAt: new Date(now + 60_000).toISOString(), fees: [], warnings: [], provider: 'TEST_ONLY',
      transaction: { kind: 'evm', chainId: 42161, to: `0x${'4'.repeat(40)}`, data: '0x1234', value: '0' }, providerData: { privateSecret: secret } })),
    verifySourceTransaction: vi.fn(async () => ({ valid: true, pending: false })),
    trackOrder: vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'bridging', statusMessage: 'TEST_ONLY pending' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: iso() })),
  };
  const store = new Store(path), service = new OrderService(store, provider, { tokenSecret: secret, now: () => now, funnel: observer, onTrackingUnavailable });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.stop(); store.close(); } };
  cleanup.push(close);
  const create = async (key = 'test-operations-order-key') => { const quote = await service.quote(input); return service.create(quote.id, key); };
  return { path, provider, store, service, close, create, advance: (ms: number) => { now += ms; }, at: () => new Date(now).toISOString() };
}
const completion = (ledgerAt?: string): TrackingUpdate => ({ status: 'completed', statusMessage: 'TEST_ONLY bound credit',
  destinationTxHash: destination, creditedAmount: '99', destinationLedgerAt: ledgerAt,
  evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${destination}` }] });
function report(path: string, options: Partial<Parameters<typeof ordersReport>[1]> = {}) {
  return ordersReport(path, { from: '2026-10-22', until: '2026-10-23', now: iso(3_600_000), ...options });
}

describe('durable operation observations, isolated from money state', () => {
  it('persists quote, source and verified observations separately from the matching ledger time', async () => {
    const env = setup(), created = await env.create();
    expect(created.order.quote.observedAt).toBe(iso());
    env.advance(1000);
    const submitted = await env.service.submit(created.order.id, created.accessToken, hash);
    expect(submitted.timings).toMatchObject({ quoteObservedAt: iso(), sourceSubmittedObservedAt: iso(1000), sourceConfirmedObservedAt: iso(1000) });
    env.advance(2000); env.provider.trackOrder = vi.fn(async () => completion(iso(2000)));
    const completed = await env.service.refresh(created.order.id);
    expect(completed.timings).toMatchObject({ creditVerifiedObservedAt: iso(3000), destinationLedgerAt: iso(2000) });
    await env.close();
    const reopened = new Store(env.path); cleanup.push(() => reopened.close());
    const resumed = new OrderService(reopened, env.provider, { tokenSecret: secret });
    expect(await resumed.get(created.order.id, created.accessToken)).toEqual(completed);
    expect(reopened.ready()).toBe(true);
  });
  it('keeps first per-stage claims, supports out-of-order arrival, and never advances financial progress', async () => {
    const env = setup(), created = await env.create();
    env.advance(2000);
    const broadcast = { stage: 'broadcast', eventId: event2, observedAt: iso(1000) };
    const first = await env.service.recordClientStage(created.order.id, created.accessToken, broadcast);
    env.advance(1000);
    expect(await env.service.recordClientStage(created.order.id, created.accessToken, broadcast)).toEqual(first);
    const both = await env.service.recordClientStage(created.order.id, created.accessToken, { stage: 'signing', eventId: event1, observedAt: iso(500) });
    expect(both.clientStages).toEqual({ broadcast: { eventId: event2, observedAt: iso(1000), receivedAt: iso(2000) },
      signing: { eventId: event1, observedAt: iso(500), receivedAt: iso(3000) } });
    expect(both.events).toEqual(created.order.events); expect(both.updatedAt).toBe(created.order.updatedAt);
    expect(both.status).toBe('awaiting_signature'); expect(both.sourceTxHash).toBeUndefined(); expect(both.destinationTxHash).toBeUndefined();
    const retry = await env.service.recordClientStage(created.order.id, created.accessToken, { stage: 'signing', eventId: '33333333-3333-4333-8333-333333333333', observedAt: iso(2000) });
    expect(retry).toEqual(both);
    await env.close(); const stored = report(env.path).rows[0];
    expect(stored.unreportedClientPaymentClaim).toBe(true); expect(stored.verifiedCompleted).toBe(false);
  });
  it('rejects extra fields, spoofed completion, invalid timestamps, reused event IDs and unauthorized claims', async () => {
    const env = setup(), created = await env.create();
    const base = { stage: 'signing', eventId: event1, observedAt: iso() };
    for (const value of [{ ...base, stage: 'completed' }, { ...base, sourceTxHash: hash }, { ...base, status: 'completed' },
      { ...base, observedAt: 'yesterday' }, { ...base, observedAt: iso(300_001) }, { ...base, eventId: 'invalid' }]) {
      await expect(env.service.recordClientStage(created.order.id, created.accessToken, value)).rejects.toThrow();
    }
    await expect(env.service.recordClientStage(created.order.id, 'wrong', base)).rejects.toThrow('访问令牌无效');
    await env.service.recordClientStage(created.order.id, created.accessToken, base);
    await expect(env.service.recordClientStage(created.order.id, created.accessToken, { ...base, stage: 'broadcast' })).rejects.toThrow('其他记录');
    await expect(env.service.recordClientStage(created.order.id, created.accessToken, { ...base, observedAt: iso(1) })).rejects.toThrow('其他记录');
    expect(env.store.getOrder(created.order.id)?.order.status).toBe('awaiting_signature');
  });
  it('serializes stage observations with delayed verification and preserves them across stale metadata snapshots', async () => {
    const env = setup(), created = await env.create();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    env.provider.verifySourceTransaction = vi.fn(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { valid: true, pending: false }; });
    const submitting = env.service.submit(created.order.id, created.accessToken, hash); await started;
    const stage = env.service.recordClientStage(created.order.id, created.accessToken, { stage: 'broadcast', eventId: event2, observedAt: iso() });
    release(); await submitting; const recorded = await stage;
    expect(recorded.status).toBe('bridging'); expect(recorded.clientStages?.broadcast?.eventId).toBe(event2);
    const stale = { ...recorded }; delete stale.clientStages;
    const merged = env.store.updateOrder(stale);
    expect(merged.clientStages).toEqual(recorded.clientStages);
    expect(env.store.getOrder(created.order.id)?.order.clientStages).toEqual(recorded.clientStages);
  });
  it('does not accept a ledger timestamp as completion evidence or let a bad time break verified money state', async () => {
    const env = setup(), created = await env.create(); await env.service.submit(created.order.id, created.accessToken, hash);
    env.advance(1000); env.provider.trackOrder = vi.fn(async () => ({ ...completion(iso(500)), evidence: [] }));
    const unbound = await env.service.refresh(created.order.id);
    expect(unbound.status).toBe('verifying_credit'); expect(unbound.timings?.destinationLedgerAt).toBeUndefined();
    env.provider.trackOrder = vi.fn(async () => completion(iso(999_999)));
    const completed = await env.service.refresh(created.order.id);
    expect(completed.status).toBe('completed'); expect(completed.timings?.destinationLedgerAt).toBeUndefined();
  });
  it('preserves the original ledger timestamp only on the exact matched entry', () => {
    const ledger = [{ time: start + 1000, hash: destination, delta: { type: 'send', destination: recipient, destinationDex: '', token: 'USDC', amount: '99' } }];
    expect(findPerpsCredit(ledger, recipient, [destination], '98', start)).toEqual({ hash: destination, amount: '99', time: start + 1000 });
    expect(findPerpsCredit(ledger, source, [destination], '98', start)).toBeUndefined();
  });
  it('commits before calling observers and isolates observer failures and mutations', async () => {
    let env: ReturnType<typeof setup>;
    const observer: FundingObserver = { publicConfig: () => ({ enabled: true }), quoteStarted: vi.fn(() => { throw new Error('analytics down'); }),
      quoteSucceeded: vi.fn(() => { throw new Error('analytics down'); }), quoteFailed: vi.fn(),
      order: vi.fn(order => { expect(env.store.getOrder(order.id)?.order.status).toBe(order.status); order.status = 'completed'; throw new Error('analytics down'); }) };
    env = setup(observer); const created = await env.create();
    expect(created.order.status).toBe('awaiting_signature'); expect(env.store.getOrder(created.order.id)?.order.status).toBe('awaiting_signature');
    await expect(env.service.quote({ ...input, amount: '1' })).rejects.toThrow('入金金额');
    expect(observer.quoteFailed).toHaveBeenCalledOnce();
    const submitted = await env.service.submit(created.order.id, created.accessToken, hash);
    expect(submitted.status).toBe('bridging');
  });
  it('reports only a route diagnostic for background tracking outages and isolates diagnostic failures', async () => {
    const diagnostic = vi.fn(() => { throw new Error('TEST_ONLY diagnostic down'); });
    const env = setup(undefined, diagnostic), created = await env.create();
    await env.service.submit(created.order.id, created.accessToken, hash);
    env.provider.trackOrder = vi.fn(async () => { throw new Error(`TEST_ONLY raw secret ${secret} ${hash}`); });
    const checked = await env.service.refresh(created.order.id);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(input.routeId);
    expect(checked.status).toBe('bridging'); expect(checked.sourceTxHash).toBe(hash);
    expect(checked.trackingCheck?.result).toBe('unavailable'); expect(checked.statusMessage).not.toContain(secret);
    expect(env.store.getOrder(created.order.id)?.order).toEqual(checked);
  });
});

describe('read-only, private operational report', () => {
  it('reads legacy schema/payloads without migration, backfills only observed history and retains null claims/ledger time', async () => {
    const env = setup(), created = await env.create(); await env.service.submit(created.order.id, created.accessToken, hash);
    env.advance(3000); env.provider.trackOrder = vi.fn(async () => completion());
    await env.service.refresh(created.order.id); await env.close();
    const db = new DatabaseSync(env.path);
    const raw = db.prepare('SELECT payload FROM orders').get() as { payload: string }; const legacy = JSON.parse(raw.payload) as Order;
    delete legacy.timings; delete legacy.quote.observedAt;
    db.prepare('UPDATE orders SET payload=?').run(JSON.stringify(legacy));
    const schema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(); db.close();
    const before = readFileSync(env.path); const result = report(env.path);
    expect(result.rows[0]).toMatchObject({ quoteObservedAt: iso(), sourceConfirmedObservedAt: iso(), creditVerifiedObservedAt: iso(3000),
      signingClientClaimAt: null, broadcastClientClaimAt: null, destinationLedgerAt: null });
    expect(readFileSync(env.path)).toEqual(before);
    const check = new DatabaseSync(env.path, { readOnly: true });
    expect(check.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(schema); check.close();
    const reopened = new Store(env.path); cleanup.push(() => reopened.close());
    const resumed = new OrderService(reopened, env.provider, { tokenSecret: secret });
    expect((await resumed.get(created.order.id, created.accessToken)).timings).toBeUndefined();
  });
  it('uses funded/mature cohorts, excludes missing durations, flags unpaid-unknown expiration and query outages without calling them failure', async () => {
    const env = setup(); const complete = await env.create('test-completed-key'); env.advance(1000);
    await env.service.submit(complete.order.id, complete.accessToken, hash); env.advance(2000);
    env.provider.trackOrder = vi.fn(async () => completion(iso(2000))); await env.service.refresh(complete.order.id);
    const attention = await env.create('test-attention-key'); await env.service.submit(attention.order.id, attention.accessToken, `0x${'c'.repeat(64)}`);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'attention', statusMessage: 'TEST_ONLY refund needs review' }));
    await env.service.refresh(attention.order.id);
    const unsigned = await env.create('test-unsigned-key');
    const unavailable = await env.create('test-unavailable-key'); await env.service.submit(unavailable.order.id, unavailable.accessToken, `0x${'d'.repeat(64)}`);
    env.provider.trackOrder = vi.fn(async () => { throw new Error('TEST_ONLY outage'); }); await env.service.refresh(unavailable.order.id);
    const result = report(env.path);
    expect(result.summary).toMatchObject({ createdOrders: 4, sourceConfirmedOrders: 3, verifiedCompletedOrders: 1,
      observedCompletionRate: 1 / 3, matureSourceConfirmedOrders: 3, matureObservedCompletionRate: 1 / 3,
      unresolvedSourceConfirmedOrders: 2, attentionOrders: 1, queryUnavailableOrders: 1, expiredWithoutReportedSourceOrders: 1 });
    expect(result.summary.durations.creationToVerified).toEqual({ samples: 1, averageMs: 3000, p50Ms: 3000, p95Ms: 3000 });
    expect(result.summary.durations.sourceSubmissionToVerified.averageMs).toBe(2000);
    expect(result.summary.durations.ledgerToVerification.averageMs).toBe(1000);
    expect(result.rows.find(row => row.sourceReported === false)?.status).toBe('awaiting_signature');
    expect(env.store.getOrder(unsigned.order.id)?.order.status).toBe('awaiting_signature');
    expect(report(env.path, { routeId: 'not-this-route' }).summary.observedCompletionRate).toBeNull();
  });
  it('keeps stage age across same-state refresh error messages and exposes clock anomalies', async () => {
    const env = setup(), created = await env.create(); await env.service.submit(created.order.id, created.accessToken, hash);
    env.advance(10_000); env.provider.trackOrder = vi.fn(async () => { throw new Error('outage'); }); await env.service.refresh(created.order.id);
    await env.service.recordClientStage(created.order.id, created.accessToken, { stage: 'signing', eventId: event1, observedAt: iso(5000) });
    await env.service.recordClientStage(created.order.id, created.accessToken, { stage: 'broadcast', eventId: event2, observedAt: iso(1000) });
    const row = report(env.path).rows[0]; expect(row.currentStageSince).toBe(iso());
    expect(row.currentStageAgeMs).toBe(3_600_000); expect(row.stalled).toBe(true); expect(row.timingAnomaly).toBe(true);
  });
  it('keeps completion-rate numerator within its source-confirmed cohort when legacy stages are missing', async () => {
    const env = setup();
    const legacy = await env.create('legacy-missing-source-time');
    await env.service.submit(legacy.order.id, legacy.accessToken, hash);
    env.advance(1000); env.provider.trackOrder = vi.fn(async () => completion());
    await env.service.refresh(legacy.order.id);
    const confirmed = await env.create('completed-with-source-time');
    await env.service.submit(confirmed.order.id, confirmed.accessToken, `0x${'c'.repeat(64)}`);
    env.advance(1000); await env.service.refresh(confirmed.order.id); await env.close();
    const db = new DatabaseSync(env.path);
    const record = db.prepare('SELECT payload FROM orders WHERE id=?').get(legacy.order.id) as { payload: string };
    const order = JSON.parse(record.payload) as Order;
    order.events = order.events.filter(event => event.status === 'awaiting_signature');
    order.timings = { creditVerifiedObservedAt: iso(1000) };
    db.prepare('UPDATE orders SET payload=? WHERE id=?').run(JSON.stringify(order), order.id); db.close();
    const result = report(env.path);
    expect(result.summary).toMatchObject({ verifiedCompletedOrders: 2, sourceConfirmedOrders: 1,
      sourceConfirmedCompletedOrders: 1, verifiedCompletedWithoutSourceTimingOrders: 1, observedCompletionRate: 1,
      matureSourceConfirmedOrders: 1, matureVerifiedCompletedOrders: 1, matureObservedCompletionRate: 1 });
    expect(result.rows.filter(row => row.verifiedCompleted && !row.sourceConfirmed)).toHaveLength(1);
    expect(result.byRoute[0].observedCompletionRate).toBe(1);
    expect(result.byCreatedDayUTC[0].observedCompletionRate).toBe(1);
  });
  it('calculates average and nearest-rank percentiles on completed known samples and separates immature cohorts', async () => {
    const env = setup();
    for (let index = 1; index <= 4; index++) {
      const created = await env.create(`test-duration-key-${index}`);
      await env.service.submit(created.order.id, created.accessToken, `0x${String(index).repeat(64)}`);
      env.advance(index * 1000); env.provider.trackOrder = vi.fn(async () => completion());
      await env.service.refresh(created.order.id);
    }
    const result = report(env.path, { now: env.at(), maturityMs: 30_000 });
    expect(result.summary.durations.creationToVerified).toEqual({ samples: 4, averageMs: 2500, p50Ms: 2000, p95Ms: 4000 });
    expect(result.summary.observedCompletionRate).toBe(1); expect(result.summary.matureObservedCompletionRate).toBeNull();
  });
  it('exports a single whitelisted row per order, excludes secrets by default and neutralizes CSV formulas', async () => {
    const env = setup(), created = await env.create(); await env.service.submit(created.order.id, created.accessToken, hash); await env.close();
    const db = new DatabaseSync(env.path), raw = db.prepare('SELECT payload FROM orders').get() as { payload: string };
    const modified = JSON.parse(raw.payload) as Order; modified.quote.routeId = '=HYPERLINK("https://example.invalid")';
    modified.statusMessage = 'PRIVATE_TOKEN_DO_NOT_EXPORT'; db.prepare('UPDATE orders SET payload=?').run(JSON.stringify(modified)); db.close();
    const result = report(env.path), json = JSON.stringify(result);
    expect(result.rows).toHaveLength(1);
    for (const privateValue of [source, recipient, hash, created.accessToken, created.order.id, secret, modified.statusMessage]) expect(json).not.toContain(privateValue);
    const csv = ordersCsv(result.rows); expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"'); expect(csv.split('\r\n')).toHaveLength(3);
    const sensitive = report(env.path, { includeSensitive: true }); expect(sensitive.rows[0].sourceAddress).toBe(source);
    expect(JSON.stringify(sensitive)).not.toContain(created.accessToken); expect(JSON.stringify(sensitive)).not.toContain(secret);
    for (const prefix of ['=', '+', '-', '@', '\t=', '\r@', '  +']) {
      expect(ordersCsv([{ ...result.rows[0], routeId: `${prefix}formula` }])).toContain(`"'${prefix}formula"`);
    }
  });
  it('rejects invalid UTC windows instead of reporting zero', () => {
    expect(() => report('/not/a/database', { from: '2026-02-30' })).toThrow();
    expect(() => report('/not/a/database', { from: '2026-10-23', until: '2026-10-22' })).toThrow();
    expect(() => report('/not/a/database', { staleAfterMs: 0 })).toThrow();
  });
});
