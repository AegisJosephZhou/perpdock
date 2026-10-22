import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import type { ProviderAdapter, ProviderQuote, QuoteRequest, TrackingUpdate } from '../shared/types.js';
import { validAttribution } from '../shared/attribution.js';
import { AttributionRecorder, ATTRIBUTION_LIMITS, attributionConfiguration } from '../server/attribution.js';
import { Store } from '../server/store.js';
import { OrderService } from '../server/order-service.js';
import { createApp } from '../server/app.js';
import { attributionReport } from '../scripts/attribution-report.js';

const campaign = 'x_en_launch';
const config = { enabled: true as const, campaigns: [campaign, 'partner_demo', 'test_qa'] };
const context = () => ({ sessionId: randomUUID(), campaign, source: 'x' as const, medium: 'organic_social' as const, lang: 'en' as const });
const request: QuoteRequest = { routeId: 'arb-usdc', amount: '100', sourceAddress: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}` };
const sourceHash = `0x${'a'.repeat(64)}`, destinationHash = `0x${'b'.repeat(64)}`;
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function setup(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'dock-attribution-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'attribution.sqlite');
  const diagnostic = vi.fn();
  const recorder = enabled ? new AttributionRecorder(path, config, diagnostic) : undefined;
  if (recorder) cleanups.push(() => recorder.close());
  const store = new Store(join(dir, 'funding.sqlite'));
  cleanups.push(() => store.close());
  let now = Date.now();
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
  const service = new OrderService(store, provider, { tokenSecret: 'isolated-test-only-secret-never-used-for-users', attribution: recorder, now: () => now });
  cleanups.push(() => service.stop());
  const read = <T = Record<string, unknown>>(sql: string): T[] => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare(sql).all() as T[]; } finally { db.close(); }
  };
  return { path, store, recorder, diagnostic, service, provider, read, advance: () => { now += 1_000; } };
}
async function listen(env: ReturnType<typeof setup>, max = 120) {
  const app = createApp(env.service, { allowedOrigins: ['http://localhost'], logging: false, rateLimitMax: max });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const post = (base: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('strict optional attribution', () => {
  it('is disabled by default, fails invalid configuration closed, and leaves old orders unchanged', async () => {
    expect(attributionConfiguration()).toBeUndefined();
    expect(attributionConfiguration('false', campaign)).toBeUndefined();
    expect(attributionConfiguration('true', 'https://private.example')).toBeUndefined();
    expect(attributionConfiguration('true', `${campaign},${campaign}`)).toBeUndefined();
    const env = setup(false);
    const quote = await env.service.quote(request, context());
    const created = env.service.create(quote.id, 'legacy-order-test-key');
    expect((await env.service.config()).attribution).toBeUndefined();
    expect(existsSync(env.path)).toBe(false);
    expect(env.service.authorize(created.order.id, created.accessToken)).toEqual(created.order);
    expect(Object.keys(created.order.quote)).not.toContain('attribution');
  });
  it('rejects unknown, overlong and extra metadata instead of persisting free text', () => {
    const good = context();
    for (const bad of [
      { ...good, campaign: 'unapproved' }, { ...good, campaign: 'a'.repeat(65) },
      { ...good, source: 'https://secret.example' }, { ...good, medium: 'paid' },
      { ...good, lang: 'english' }, { ...good, sessionId: request.sourceAddress },
      { ...good, event: 'deposit_completed' }, { ...good, wallet: request.sourceAddress },
      { ...good, source: 'partner' },
    ]) expect(validAttribution(bad, config.campaigns)).toBeUndefined();
    expect(validAttribution(good, config.campaigns)).toEqual(good);
  });
  it('keeps immutable first source and never forwards metadata to the provider or public order', async () => {
    const env = setup(), source = context();
    expect(env.service.recordLanding(source)).toBe(true);
    expect(env.service.recordLanding(source)).toBe(true);
    const changed = { ...source, campaign: 'partner_demo', source: 'partner', medium: 'referral' };
    expect(env.service.recordLanding(changed)).toBe(false);
    await env.service.quote(request, changed);
    const quote = await env.service.quote(request, source);
    const created = env.service.create(quote.id, 'first-source-test-key');
    expect(env.read('SELECT * FROM attribution_sessions')).toHaveLength(1);
    expect(env.read('SELECT * FROM attribution_quotes')).toHaveLength(1);
    expect(env.provider.getQuote).toHaveBeenLastCalledWith(request);
    expect(JSON.stringify(created)).not.toContain(source.sessionId);
    expect(JSON.stringify(created)).not.toContain(campaign);
  });
  it('drops malformed quote attribution without blocking a valid quote and isolates landing rate limits', async () => {
    const env = setup(), base = await listen(env, 2), source = context();
    for (let index = 0; index < 21; index++) {
      const response = await post(base, '/api/attribution/landing', source);
      expect(response.status).toBe(index < 20 ? 200 : 429);
    }
    const response = await post(base, '/api/quotes', { ...request, attribution: { ...source, event: 'completed' } });
    expect(response.status).toBe(201);
    expect(env.read('SELECT * FROM attribution_quotes')).toHaveLength(0);
    expect((await fetch(`${base}/api/attribution/report`)).status).toBe(404);
  });
});

describe('server facts, idempotency and failure isolation', () => {
  it('does not fabricate a landing or count failed quotes', async () => {
    const env = setup(), source = context();
    await expect(env.service.quote({ ...request, amount: '0' }, source)).rejects.toThrow();
    expect(env.read('SELECT * FROM attribution_sessions')).toHaveLength(0);
    await env.service.quote(request, source);
    expect(env.read('SELECT landing_at FROM attribution_sessions')).toEqual([{ landing_at: null }]);
  });
  it('counts only committed verified stages once, not pending or provider-only success', async () => {
    const env = setup(), source = context();
    env.service.recordLanding(source);
    const quote = await env.service.quote(request, source);
    const created = env.service.create(quote.id, 'one-order-test-key');
    env.service.create(quote.id, 'one-order-test-key');
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: true }));
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    expect(env.read('SELECT source_confirmed_at, completed_at FROM attribution_orders')).toEqual([{ source_confirmed_at: null, completed_at: null }]);
    env.advance();
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'unproven', creditedAmount: '99' }));
    expect((await env.service.refresh(created.order.id)).status).toBe('verifying_credit');
    expect(env.read('SELECT source_confirmed_at, completed_at FROM attribution_orders')[0]).toMatchObject({ source_confirmed_at: expect.any(String), completed_at: null });
    env.advance();
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'verified', creditedAmount: '99',
      destinationTxHash: destinationHash, evidence: [{ type: 'hypercore_credit', reference: `${request.recipient}:${destinationHash}` }] }));
    expect((await env.service.refresh(created.order.id)).status).toBe('completed');
    const before = env.read('SELECT * FROM attribution_orders');
    await env.service.refresh(created.order.id);
    env.service.create(quote.id, 'one-order-test-key');
    expect(env.read('SELECT * FROM attribution_orders')).toEqual(before);
    expect(before).toHaveLength(1);
    expect(before[0].completed_at).toEqual(expect.any(String));
  });
  it('does not attribute an old/unlabelled order or failed duplicate source transfer', async () => {
    const env = setup();
    const plain = await env.service.quote(request);
    const old = env.service.create(plain.id, 'unattributed-order-key');
    await env.service.submit(old.order.id, old.accessToken, sourceHash);
    const labelled = await env.service.quote(request, context());
    const current = env.service.create(labelled.id, 'attributed-order-key');
    await expect(env.service.submit(current.order.id, current.accessToken, sourceHash)).rejects.toThrow();
    expect(env.read('SELECT source_confirmed_at, completed_at FROM attribution_orders')).toEqual([{ source_confirmed_at: null, completed_at: null }]);
  });
  it('preserves a successful financial result if the analytics database fails', async () => {
    const env = setup();
    const db = new DatabaseSync(env.path); db.exec('DROP TABLE attribution_quotes'); db.close();
    const quote = await env.service.quote(request, context());
    expect(env.store.getQuote(quote.id)?.id).toBe(quote.id);
    const created = env.service.create(quote.id, 'collector-failure-test-key');
    await expect(env.service.submit(created.order.id, created.accessToken, sourceHash)).resolves.toMatchObject({ status: 'bridging' });
    expect(env.diagnostic).toHaveBeenCalledTimes(1);
    expect((await env.service.config()).attribution).toBeUndefined();
  });
  it('drops new sessions at capacity while keeping funding available', async () => {
    const env = setup();
    const db = new DatabaseSync(env.path);
    db.exec('BEGIN');
    const insert = db.prepare(`INSERT INTO attribution_sessions (session_id,campaign,source,medium,lang,first_seen_at)
      VALUES (?,?,'x','organic_social','en',?)`);
    for (let index = 0; index < ATTRIBUTION_LIMITS.sessions; index++) insert.run(randomUUID(), campaign, new Date().toISOString());
    db.exec('COMMIT'); db.close();
    expect(env.service.recordLanding(context())).toBe(false);
    const quote = await env.service.quote(request, context());
    expect(quote.id).toEqual(expect.any(String));
    expect(env.read('SELECT * FROM attribution_quotes')).toHaveLength(0);
    expect(env.read('SELECT count FROM attribution_counters WHERE name=\'capacity_dropped_sessions\'')).toEqual([{ count: 2 }]);
  });
});

describe('private read-only reports and retention', () => {
  it('groups cohorts without multiplying rows, excludes test campaigns, and exposes no identifiers', async () => {
    const env = setup(), source = context();
    env.service.recordLanding(source);
    const one = await env.service.quote(request, source), two = await env.service.quote(request, source);
    env.service.create(one.id, 'report-first-order-key'); env.service.create(two.id, 'report-second-order-key');
    await env.service.quote(request, { ...context(), campaign: 'test_qa' });
    const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const report = attributionReport(env.path, from, until);
    expect(report.cohort).toHaveLength(1);
    expect(report.cohort[0]).toMatchObject({ attributed_sessions: 1, observed_landing_sessions: 1, successful_quotes: 2, created_orders: 2, verified_completed_orders: 0 });
    const serialized = JSON.stringify(report);
    for (const forbidden of [source.sessionId, one.id, two.id, request.sourceAddress, request.recipient, sourceHash, 'accessToken']) expect(serialized).not.toContain(forbidden);
    expect(() => attributionReport(env.path, '2026-02-30', until)).toThrow();
    expect(() => attributionReport(`${env.path}.missing`, from, until)).toThrow();
    expect(existsSync(`${env.path}.missing`)).toBe(false);
    expect(env.read('SELECT * FROM attribution_quotes')).toHaveLength(3);
  });
  it('expires analytics and dependent rows on restart without touching financial orders', async () => {
    const env = setup(), source = context();
    const quote = await env.service.quote(request, source);
    const created = env.service.create(quote.id, 'retention-order-test-key');
    env.recorder!.close();
    const db = new DatabaseSync(env.path);
    db.prepare('UPDATE attribution_sessions SET first_seen_at=?').run(new Date(Date.now() - 31 * 86_400_000).toISOString()); db.close();
    const reopened = new AttributionRecorder(env.path, config); cleanups.push(() => reopened.close());
    expect(env.read('SELECT * FROM attribution_sessions')).toHaveLength(0);
    expect(env.read('SELECT * FROM attribution_quotes')).toHaveLength(0);
    expect(env.read('SELECT * FROM attribution_orders')).toHaveLength(0);
    expect(env.service.authorize(created.order.id, created.accessToken).id).toBe(created.order.id);
  });
});
