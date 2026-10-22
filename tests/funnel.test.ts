import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FunnelRecorder, FUNNEL_LIMITS, funnelConfiguration, type FunnelRecorderConfig } from '../server/funnel.js';
import { validFunnelClientEvent, validFunnelContext } from '../shared/funnel.js';
import { Store } from '../server/store.js';
import { OrderService } from '../server/order-service.js';
import type { ProviderAdapter, ProviderQuote, QuoteRequest, TrackingUpdate } from '../shared/types.js';
import { funnelReport } from '../scripts/funnel-report.js';

const posthog = { enabled: true as const, posthog: { apiKey: 'phc_isolated_test_project_only', host: 'https://us.i.posthog.com' } };
const ctx = () => ({ sessionId: randomUUID(), attemptId: randomUUID(), lang: 'en' as const });
const request: QuoteRequest = { routeId: 'arbitrum-usdc-hypercore', amount: '100', sourceAddress: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}` };
const sourceHash = `0x${'a'.repeat(64)}`, destinationHash = `0x${'b'.repeat(64)}`;
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function setup(config: FunnelRecorderConfig = { enabled: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'dock-funnel-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'funnel.sqlite');
  let now = Date.parse('2026-10-22T22:00:00.000Z');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }));
  const diagnostic = vi.fn();
  const recorder = new FunnelRecorder(path, config, { now: () => now, fetch: fetcher, diagnostic });
  cleanups.push(() => recorder.close());
  const store = new Store(join(dir, 'orders.sqlite')); cleanups.push(() => store.close());
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [{ id: request.routeId, label: 'Arbitrum USDC', sourceChain: 'Arbitrum', sourceChainId: 42161,
      sourceToken: `0x${'3'.repeat(40)}`, symbol: 'USDC', decimals: 6, walletType: 'evm' as const, available: true }]),
    getQuote: vi.fn(async (input: QuoteRequest): Promise<ProviderQuote> => ({ ...input, amountBaseUnits: '100000000',
      expectedReceive: '99', minReceive: '98', expiresAt: new Date(now + 60_000).toISOString(), provider: 'TEST_ONLY', fees: [], warnings: [],
      transaction: { kind: 'evm', chainId: 42161, to: `0x${'4'.repeat(40)}`, data: '0x1234', value: '0' }, providerData: {} })),
    verifySourceTransaction: vi.fn(async () => ({ valid: true, pending: false })),
    trackOrder: vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'bridging', statusMessage: 'pending' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date(now).toISOString() })),
  };
  const service = new OrderService(store, provider, { tokenSecret: 'isolated-funnel-test-secret', funnel: recorder, now: () => now });
  cleanups.push(() => service.stop());
  const read = <T = Record<string, unknown>>(sql: string): T[] => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
  };
  const mutate = (sql: string) => { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } };
  return { dir, path, config, recorder, store, service, provider, fetcher, diagnostic, read, mutate,
    at: () => new Date(now).toISOString(), now: () => now, advance: (ms = 1_000) => { now += ms; } };
}

describe('funnel authority and privacy boundaries', () => {
  it('is off by default; local-only needs no key, explicit bad export fails with a fixed safe error', async () => {
    expect(funnelConfiguration()).toBeUndefined();
    expect(funnelConfiguration('false', 'true', 'secret key', 'http://private-host')).toBeUndefined();
    expect(funnelConfiguration('true')).toEqual({ enabled: true });
    for (const [key, host] of [[undefined, undefined], ['private key', 'https://us.i.posthog.com'], [posthog.posthog.apiKey, 'https://attacker.example']]) {
      expect(() => funnelConfiguration('true', 'true', key, host)).toThrow('Invalid PostHog configuration. Check the project key and supported ingestion host.');
    }
    const env = setup(); env.recorder.client({ ...ctx(), eventId: randomUUID(), event: 'landing' }, env.at());
    await env.recorder.flush(); expect(env.fetcher).not.toHaveBeenCalled();
    expect(env.read('SELECT delivery FROM funnel_events')).toEqual([{ delivery: 'local_only' }]);
  });
  it('does not accept funds success, arbitrary metadata, URLs or identity-bearing context', () => {
    const context = ctx(), base = { ...context, eventId: randomUUID(), event: 'landing' };
    expect(validFunnelContext(context)).toEqual(context);
    for (const value of [{ ...context, sessionId: request.sourceAddress }, { ...context, url: 'https://private.example' }, { ...context, amount: '100' }]) {
      expect(validFunnelContext(value)).toBeUndefined();
    }
    const env = setup();
    for (const value of [{ ...base, event: 'credit_verified' }, { ...base, event: 'source_confirmed' },
      { ...base, event: 'order_created' }, { ...base, accessToken: 'secret' }, { ...base, error: 'sensitive' },
      { ...base, routeId: request.sourceAddress }, { ...base, walletType: 'private-wallet-name' }]) {
      expect(validFunnelClientEvent(value)).toBeUndefined(); expect(env.recorder.client(value, env.at())).toBe(false);
    }
    expect(env.read('SELECT * FROM funnel_events')).toEqual([]);
  });
  it('collects unlabelled traffic, uses immutable session and deduplicates repeated UI event IDs', () => {
    const env = setup(), input = { ...ctx(), eventId: randomUUID(), event: 'wallet_connect_started' };
    expect(env.recorder.client(input, env.at())).toBe(true);
    expect(env.recorder.client(input, env.at())).toBe(true);
    expect(env.recorder.client({ ...input, lang: 'zh' }, env.at())).toBe(false);
    env.recorder.client({ ...input, eventId: randomUUID(), event: 'landing' }, env.at());
    env.recorder.client({ ...input, eventId: randomUUID(), event: 'landing' }, env.at());
    expect(env.read('SELECT * FROM funnel_sessions')).toHaveLength(1);
    expect(env.read('SELECT event FROM funnel_events')).toHaveLength(2);
  });
  it('records server quote failure/success and idempotent creation, never sends metadata to provider', async () => {
    const env = setup(), context = ctx();
    await expect(env.service.quote({ ...request, amount: '0' }, undefined, context)).rejects.toThrow();
    const quote = await env.service.quote(request, undefined, { ...context, attemptId: randomUUID() });
    const order = env.service.create(quote.id, 'one-funnel-order');
    env.service.create(quote.id, 'one-funnel-order');
    expect(env.provider.getQuote).toHaveBeenLastCalledWith(request);
    expect(JSON.stringify(order)).not.toContain(context.sessionId);
    expect(env.read('SELECT event,authority FROM funnel_events WHERE event != \'quote_requested\' ORDER BY event'))
      .toEqual([{ event: 'order_created', authority: 'server' }, { event: 'quote_failed', authority: 'server' }, { event: 'quote_succeeded', authority: 'server' }]);
    expect(env.read('SELECT * FROM funnel_orders')).toHaveLength(1);
  });
  it('only counts committed source and bound credit, with client signing/broadcast separated', async () => {
    const env = setup(), context = ctx();
    const quote = await env.service.quote(request, undefined, context);
    const { order, accessToken } = env.service.create(quote.id, 'verified-order');
    await env.service.recordClientStage(order.id, accessToken, { stage: 'signing', eventId: randomUUID(), observedAt: env.at() });
    env.advance();
    await env.service.recordClientStage(order.id, accessToken, { stage: 'broadcast', eventId: randomUUID(), observedAt: env.at() });
    expect(env.read("SELECT event,authority FROM funnel_events WHERE authority='authenticated_client' ORDER BY event"))
      .toEqual([{ event: 'broadcast_observed', authority: 'authenticated_client' }, { event: 'signing_started', authority: 'authenticated_client' }]);
    expect(env.read("SELECT * FROM funnel_events WHERE event IN ('source_confirmed','credit_verified')")).toEqual([]);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: true }));
    await env.service.submit(order.id, accessToken, sourceHash);
    expect(env.read("SELECT * FROM funnel_events WHERE event='source_confirmed'")).toEqual([]);
    env.advance(); env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'not bound', creditedAmount: '99' }));
    await env.service.refresh(order.id);
    expect(env.read("SELECT * FROM funnel_events WHERE event='source_confirmed'")).toHaveLength(1);
    expect(env.read("SELECT * FROM funnel_events WHERE event='credit_verified'")).toEqual([]);
    env.advance(); env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'bound', creditedAmount: '99', destinationTxHash: destinationHash,
      evidence: [{ type: 'hypercore_credit', reference: `${request.recipient}:${destinationHash}` }] }));
    await env.service.refresh(order.id); await env.service.refresh(order.id);
    expect(env.read("SELECT authority FROM funnel_events WHERE event='credit_verified'")).toEqual([{ authority: 'server' }]);
    const legacy = await env.service.quote(request); env.service.create(legacy.id, 'unobserved-order');
    expect(env.read('SELECT * FROM funnel_orders')).toHaveLength(1);
  });
  it('a broken collector cannot fail financial commit or expose raw diagnostics', async () => {
    const env = setup(); env.mutate('DROP TABLE funnel_events');
    const quote = await env.service.quote(request, undefined, ctx());
    expect(env.store.getQuote(quote.id)).toBeTruthy();
    const { order, accessToken } = env.service.create(quote.id, 'collector-unavailable');
    await expect(env.service.submit(order.id, accessToken, sourceHash)).resolves.toMatchObject({ status: 'bridging' });
    expect(env.diagnostic).toHaveBeenCalledExactlyOnceWith();
    expect(env.recorder.publicConfig()).toBeUndefined();
  });
});

describe('bounded durable PostHog export', () => {
  it('exports only allowlisted properties and stable event UUIDs, never financial linkage or secrets', async () => {
    const env = setup(posthog), context = ctx();
    const quote = await env.service.quote(request, undefined, context);
    const created = env.service.create(quote.id, 'private-idempotency-key');
    await env.recorder.flush();
    const [url, options] = env.fetcher.mock.calls[0];
    expect(url).toBe('https://us.i.posthog.com/batch/'); expect(options?.redirect).toBe('error');
    const payload = JSON.parse(String(options?.body));
    expect(Object.keys(payload).sort()).toEqual(['api_key', 'batch']);
    for (const event of payload.batch) {
      expect(Object.keys(event).sort()).toEqual(['event', 'properties', 'timestamp', 'uuid']);
      expect(event.properties).toEqual({ distinct_id: context.sessionId, $process_person_profile: false, $geoip_disable: true,
        authority: 'server', lang: 'en', route: request.routeId });
    }
    for (const forbidden of [request.sourceAddress, request.recipient, sourceHash, destinationHash, quote.id, created.order.id, created.accessToken,
      'private-idempotency-key', '100000000', '$current_url', '$ip', 'user_agent']) expect(String(options?.body)).not.toContain(forbidden);
    expect(env.read('SELECT delivery FROM funnel_events').every(row => row.delivery === 'delivered')).toBe(true);
  });
  it('persists retry budget and UUID across restart; recovers an expired in-flight lease', async () => {
    const env = setup(posthog);
    env.recorder.client({ ...ctx(), event: 'landing', eventId: randomUUID() }, env.at());
    env.fetcher.mockRejectedValue(new Error('secret network error'));
    await env.recorder.flush(); await env.recorder.flush(); expect(env.fetcher).toHaveBeenCalledTimes(1);
    const before = env.read<{ uuid: string; attempts: number }>('SELECT uuid,attempts FROM funnel_events')[0];
    await env.recorder.close();
    env.mutate(`UPDATE funnel_events SET delivery='sending',next_attempt_at=0`);
    env.advance(5_000);
    const restarted = new FunnelRecorder(env.path, posthog, { now: env.now, fetch: env.fetcher }); cleanups.push(() => restarted.close());
    env.fetcher.mockResolvedValue(new Response('', { status: 200 })); await restarted.flush();
    const after = env.read<{ uuid: string; attempts: number; delivery: string }>('SELECT uuid,attempts,delivery FROM funnel_events')[0];
    expect(after).toEqual({ uuid: before.uuid, attempts: 2, delivery: 'delivered' });
    expect(JSON.parse(String(env.fetcher.mock.calls[1][1]?.body)).batch[0].uuid).toBe(before.uuid);
  });
  it('bounds repeated 429/network failures and permanently drops unauthorized project responses', async () => {
    const env = setup(posthog); env.recorder.client({ ...ctx(), event: 'landing', eventId: randomUUID() }, env.at());
    env.fetcher.mockImplementation(async () => new Response('', { status: 429 }));
    for (let i = 0; i < 10; i++) { await env.recorder.flush(); env.advance(300_000); }
    expect(env.fetcher).toHaveBeenCalledTimes(FUNNEL_LIMITS.maxAttempts);
    expect(env.read('SELECT attempts,delivery FROM funnel_events')).toEqual([{ attempts: FUNNEL_LIMITS.maxAttempts, delivery: 'dropped' }]);
    const second = setup(posthog); second.recorder.client({ ...ctx(), event: 'landing', eventId: randomUUID() }, second.at());
    second.fetcher.mockResolvedValue(new Response('', { status: 401 })); await second.recorder.flush(); second.advance(1_000_000); await second.recorder.flush();
    expect(second.fetcher).toHaveBeenCalledTimes(1);
  });
  it('counts a restart-expired final delivery attempt exactly once without another HTTP request', async () => {
    const env = setup(posthog);
    env.recorder.client({ ...ctx(), event: 'landing', eventId: randomUUID() }, env.at());
    await env.recorder.close();
    env.mutate(`UPDATE funnel_events SET delivery='sending',attempts=${FUNNEL_LIMITS.maxAttempts},next_attempt_at=0`);
    const restarted = new FunnelRecorder(env.path, posthog, { now: env.now, fetch: env.fetcher }); cleanups.push(() => restarted.close());
    await restarted.flush(); await restarted.flush();
    expect(env.fetcher).not.toHaveBeenCalled();
    expect(env.read('SELECT delivery,attempts FROM funnel_events')).toEqual([{ delivery: 'dropped', attempts: FUNNEL_LIMITS.maxAttempts }]);
    expect(env.read("SELECT count FROM funnel_counters WHERE name='export_dropped'")).toEqual([{ count: 1 }]);
    const report = funnelReport(env.path, '2026-10-22', '2026-10-23');
    expect(report.dropsSinceDatabaseCreation).toEqual([{ name: 'export_dropped', count: 1 }]);
  });
  it('coalesces parallel flush and sends only bounded batches without blocking a new quote', async () => {
    const env = setup(posthog), context = ctx();
    for (let i = 0; i < FUNNEL_LIMITS.batchSize + 1; i++) env.recorder.client({ ...context, event: 'wallet_connect_started', eventId: randomUUID() }, env.at());
    let resolve!: (value: Response) => void;
    env.fetcher.mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const first = env.recorder.flush(), second = env.recorder.flush();
    expect(first).toBe(second); expect(env.fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(env.fetcher.mock.calls[0][1]?.body)).batch).toHaveLength(FUNNEL_LIMITS.batchSize);
    expect((await env.service.quote(request, undefined, ctx())).id).toBeTruthy();
    resolve(new Response('', { status: 200 })); await first;
  });
  it('does not backfill local-only records and enforces retention through cascaded local links', async () => {
    const env = setup(), context = ctx();
    const quote = await env.service.quote(request, undefined, context); env.service.create(quote.id, 'retained-order');
    await env.recorder.close();
    const restarted = new FunnelRecorder(env.path, posthog, { now: env.now, fetch: env.fetcher }); cleanups.push(() => restarted.close());
    await restarted.flush(); expect(env.fetcher).not.toHaveBeenCalled();
    env.advance(31 * 86_400_000); await restarted.flush();
    for (const table of ['sessions', 'attempts', 'orders', 'events']) expect(env.read(`SELECT * FROM funnel_${table}`)).toEqual([]);
  });
  it('reports aggregate stages without identifiers and surfaces capacity drops without funds failure', async () => {
    const env = setup(), context = ctx();
    const quote = await env.service.quote(request, undefined, context); const created = env.service.create(quote.id, 'report-order');
    const report = funnelReport(env.path, '2026-10-22', '2026-10-23');
    expect(report.status).toBe('observed_funnel_data');
    for (const secret of [context.sessionId, quote.id, created.order.id, created.accessToken, request.sourceAddress]) {
      if (secret) expect(JSON.stringify(report)).not.toContain(secret);
    }
    env.mutate(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<${FUNNEL_LIMITS.sessions - 1})
      INSERT INTO funnel_sessions(session_id,lang,first_seen_at) SELECT 'capacity-' || n,'en','2026-10-22T22:00:00.000Z' FROM ids`);
    expect(env.recorder.client({ ...ctx(), eventId: randomUUID(), event: 'landing' }, env.at())).toBe(false);
    expect(env.read("SELECT count FROM funnel_counters WHERE name='capacity_dropped_sessions'")).toEqual([{ count: 1 }]);
    await expect(env.service.quote(request, undefined, ctx())).resolves.toHaveProperty('id');
  });
});
