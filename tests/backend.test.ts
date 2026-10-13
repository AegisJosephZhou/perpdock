import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ProviderAdapter, ProviderQuote, QuoteRequest, SourceVerification, TrackingUpdate } from '../shared/types.js';
import { Store } from '../server/store.js';
import { OrderService } from '../server/order-service.js';
import { createApp } from '../server/app.js';
import { decimalUnits, loadTokenSecret } from '../server/security.js';
import { UpstreamError } from '../server/chain/http.js';

const source = `0x${'1'.repeat(40)}`;
const recipient = `0x${'2'.repeat(40)}`;
const tx = `0x${'a'.repeat(64)}`;
const secret = 'test-only-secret-never-used-in-production-123456';
const request: QuoteRequest = { routeId: 'arb-usdc', amount: '100', sourceAddress: source, recipient };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

function makeProvider(now: () => number): ProviderAdapter {
  return {
    getRoutes: vi.fn(async () => [{ id: 'arb-usdc', label: 'Arbitrum USDC', sourceChain: 'Arbitrum', sourceChainId: 42161,
      sourceToken: `0x${'3'.repeat(40)}`, symbol: 'USDC', decimals: 6, walletType: 'evm' as const, available: true }]),
    getQuote: vi.fn(async (input: QuoteRequest): Promise<ProviderQuote> => ({ ...input,
      amountBaseUnits: decimalUnits(input.amount, 6).toString(), expectedReceive: '99', minReceive: '98',
      expiresAt: new Date(now() + 60_000).toISOString(), provider: 'TEST_FIXTURE_ONLY', fees: [], warnings: [],
      transaction: { kind: 'evm', chainId: 42161, to: `0x${'4'.repeat(40)}`, data: '0x1234', value: '0' },
      providerData: { privateProof: 'SERVER_ONLY_VALUE' },
    })),
    verifySourceTransaction: vi.fn(async (): Promise<SourceVerification> => ({ valid: true, pending: false })),
    trackOrder: vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'bridging', statusMessage: 'waiting' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date(now()).toISOString() })),
  };
}
function setup(path = ':memory:') {
  let clock = Date.UTC(2026, 9, 12);
  let paused = false;
  const provider = makeProvider(() => clock);
  const store = new Store(path);
  const service = new OrderService(store, provider, { tokenSecret: secret, now: () => clock, paused: () => paused });
  cleanup.push(async () => { await service.stop(); store.close(); });
  return { provider, store, service, advance: (ms: number) => { clock += ms; }, pause: () => { paused = true; } };
}
async function newOrder(env: ReturnType<typeof setup>, key = 'test-idempotency-12345') {
  const quote = await env.service.quote(request);
  return { quote, ...env.service.create(quote.id, key) };
}

describe('persistent orders and authorization', () => {
  it('retries keep the same token and order even after quote expiry and pause', async () => {
    const env = setup();
    const created = await newOrder(env);
    env.advance(120_000); env.pause();
    const retry = env.service.create(created.quote.id, 'test-idempotency-12345');
    expect(retry).toEqual({ order: created.order, accessToken: created.accessToken });
    expect(JSON.stringify(retry)).not.toContain('SERVER_ONLY_VALUE');
    expect(env.store.getQuote(created.quote.id)?.providerData).toEqual({ privateProof: 'SERVER_ONLY_VALUE' });
  });
  it('rejects different payload for an idempotency key and duplicate orders per quote', async () => {
    const env = setup();
    const one = await newOrder(env);
    const two = await env.service.quote(request);
    expect(() => env.service.create(two.id, 'test-idempotency-12345')).toThrow('另一个请求');
    expect(() => env.service.create(one.quote.id, 'test-idempotency-different')).toThrow('已创建订单');
  });
  it('keeps tokens recoverable after reopening SQLite and refuses a changed signing key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-backend-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite');
    const env = setup(path);
    const one = await newOrder(env);
    const secondStore = new Store(path); cleanup.push(() => secondStore.close());
    const second = new OrderService(secondStore, env.provider, { tokenSecret: secret });
    expect(second.create(one.quote.id, 'test-idempotency-12345').accessToken).toBe(one.accessToken);
    expect(() => new OrderService(secondStore, env.provider, { tokenSecret: 'different'.repeat(8) })).toThrow('changed');
    expect(() => second.authorize(one.order.id, 'x'.repeat(43))).toThrow('访问令牌无效');
  });
  it('uses a persistent local key and requires an explicit production key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-key-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'key');
    expect(loadTokenSecret(path)).toBe(loadTokenSecret(path));
    expect(() => loadTokenSecret(path, undefined, true)).toThrow('requires');
  });
  it('rejects invalid precision, provider substitution, and expired quotes', async () => {
    const env = setup();
    await expect(env.service.quote({ ...request, amount: '100.0000001' })).rejects.toThrow('6 位');
    const original = env.provider.getQuote;
    env.provider.getQuote = async input => ({ ...await original(input), recipient: source });
    await expect(env.service.quote(request)).rejects.toThrow('不一致');
    env.provider.getQuote = original;
    const quote = await env.service.quote(request); env.advance(61_000);
    expect(() => env.service.create(quote.id, 'long-enough-idempotency')).toThrow('已过期');
  });
});

describe('source verification and final credit', () => {
  it('rejects explicit mismatches and does not associate an unverified transaction', async () => {
    const env = setup(); const one = await newOrder(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: false, reason: 'wrong calldata' }));
    await expect(env.service.submit(one.order.id, one.accessToken, tx)).rejects.toThrow('wrong calldata');
    expect(env.store.getOrder(one.order.id)?.order.sourceTxHash).toBeUndefined();
  });
  it('does not turn pending/unknown transactions into completed orders', async () => {
    const env = setup(); const one = await newOrder(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: true }));
    expect((await env.service.submit(one.order.id, one.accessToken, tx)).status).toBe('source_pending');
    expect((await env.service.refresh(one.order.id, one.accessToken)).status).toBe('source_pending');
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
    env.provider.verifySourceTransaction = vi.fn(async () => { throw new Error('API_KEY=should-not-leak'); });
    const refreshed = await env.service.refresh(one.order.id, one.accessToken);
    expect(refreshed.status).toBe('source_pending');
    expect(refreshed.statusMessage).toContain('请勿重复付款');
    expect(JSON.stringify(refreshed)).not.toContain('API_KEY');
  });
  it('rejects hash replacement and concurrent duplicate submission only verifies once', async () => {
    const env = setup(); const one = await newOrder(env);
    const results = await Promise.all([env.service.submit(one.order.id, one.accessToken, tx), env.service.submit(one.order.id, one.accessToken, tx)]);
    expect(results[0].sourceTxHash).toBe(results[1].sourceTxHash);
    expect(env.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
    await expect(env.service.submit(one.order.id, one.accessToken, `0x${'b'.repeat(64)}`)).rejects.toThrow('不能覆盖');
  });
  it('handles late broadcasts for expired awaiting orders without dropping funds', async () => {
    const env = setup(); const one = await newOrder(env); env.advance(61_000);
    expect((await env.service.get(one.order.id, one.accessToken)).status).toBe('expired');
    expect((await env.service.submit(one.order.id, one.accessToken, tx)).status).toBe('bridging');
  });
  it('requires attributable HyperCore evidence, prevents state regression, and freezes completed state', async () => {
    const env = setup(); const one = await newOrder(env);
    await env.service.submit(one.order.id, one.accessToken, tx);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'provider success', creditedAmount: '99', evidence: [{ type: 'provider_success', reference: 'abc' }] }));
    expect((await env.service.refresh(one.order.id)).status).toBe('verifying_credit');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'bridging', statusMessage: 'stale webhook' }));
    expect((await env.service.refresh(one.order.id)).status).toBe('verifying_credit');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'credit verified', creditedAmount: '99', destinationTxHash: tx, evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${tx}` }] }));
    expect((await env.service.refresh(one.order.id)).status).toBe('completed');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { throw new Error('temporary outage'); });
    expect((await env.service.refresh(one.order.id)).status).toBe('completed');
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
  });
  it('does not assign the same confirmed source transfer to two orders', async () => {
    const env = setup(); const one = await newOrder(env); const two = await newOrder(env, 'another-idempotency-key');
    await env.service.submit(one.order.id, one.accessToken, tx);
    await expect(env.service.submit(two.order.id, two.accessToken, tx)).rejects.toThrow('已关联其他订单');
  });
  it('enforces source transaction uniqueness across route names on the same chain', async () => {
    const env = setup(); const one = await newOrder(env);
    const originalRoutes = env.provider.getRoutes;
    env.provider.getRoutes = async () => [...await originalRoutes(), { ...(await originalRoutes())[0], id: 'alias-usdc' }];
    const quote = await env.service.quote({ ...request, routeId: 'alias-usdc' });
    const two = env.service.create(quote.id, 'alias-route-idempotency');
    await env.service.submit(one.order.id, one.accessToken, tx);
    await expect(env.service.submit(two.order.id, two.accessToken, tx)).rejects.toThrow('已关联其他订单');
  });
  it('does not let an unverified pending hash reserve another payer’s confirmed transfer', async () => {
    const env = setup(); const unverified = await newOrder(env); const payer = await newOrder(env, 'actual-payer-idempotency');
    env.provider.verifySourceTransaction = vi.fn(async (quote): Promise<SourceVerification> =>
      ({ valid: true, pending: quote.id === unverified.quote.id }));
    await env.service.submit(unverified.order.id, unverified.accessToken, tx);
    expect(env.store.dueOrders(Date.UTC(2026, 9, 12)).some(order => order.id === unverified.order.id)).toBe(true);
    expect((await env.service.submit(payer.order.id, payer.accessToken, tx)).status).toBe('bridging');
    env.provider.verifySourceTransaction = vi.fn(async (): Promise<SourceVerification> => ({ valid: false, reason: 'wrong order' }));
    expect((await env.service.refresh(unverified.order.id)).status).toBe('attention');
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
  });
  it('accepts 8-decimal HyperCore amounts but rejects underpayment or unrelated credit', async () => {
    const env = setup(); const original = env.provider.getQuote;
    env.provider.getQuote = async input => ({ ...await original(input), minReceive: '98.12345678', expectedReceive: '99.23456789' });
    const one = await newOrder(env); await env.service.submit(one.order.id, one.accessToken, tx);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'credit', creditedAmount: '98.12345677', destinationTxHash: tx,
      evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${tx}` }] }));
    expect((await env.service.refresh(one.order.id)).status).toBe('verifying_credit');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'credit', creditedAmount: '99.23456789', destinationTxHash: `0x${'b'.repeat(64)}`,
      evidence: [{ type: 'hypercore_credit', reference: `${source}:${tx}` }] }));
    expect((await env.service.refresh(one.order.id)).status).toBe('verifying_credit');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'completed', statusMessage: 'credit', creditedAmount: '99.23456789', destinationTxHash: tx,
      evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${tx}` }] }));
    expect((await env.service.refresh(one.order.id)).status).toBe('completed');
  });
  it('polls saved pending orders after service reconstruction', async () => {
    const env = setup(); const one = await newOrder(env);
    await env.service.submit(one.order.id, one.accessToken, tx);
    const resumed = new OrderService(env.store, env.provider, { tokenSecret: secret });
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'verifying_credit', statusMessage: 'confirming' }));
    await resumed.tick();
    expect(env.store.getOrder(one.order.id)?.order.status).toBe('verifying_credit');
    expect(vi.mocked(env.provider.trackOrder).mock.calls[0][0].providerData).toEqual({ privateProof: 'SERVER_ONLY_VALUE' });
  });
  it('persists a private adapter cursor through SQLite reopening without changing the public quote', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hl-cursor-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'db.sqlite'); const env = setup(path); const one = await newOrder(env);
    await env.service.submit(one.order.id, one.accessToken, tx);
    const patch = { creditScan: { startTime: 1791816176000, fillHashesKey: tx }, internalDiagnostic: 'PRIVATE_CURSOR_VALUE', recipient: 'not-a-public-quote-field' };
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'verifying_credit', statusMessage: 'scanning', providerDataPatch: patch }));
    const updated = await env.service.refresh(one.order.id, one.accessToken);
    expect(updated.quote).toEqual(one.quote);
    expect(JSON.stringify(updated)).not.toContain('PRIVATE_CURSOR_VALUE');
    expect(JSON.stringify(updated)).not.toContain('providerDataPatch');
    expect(env.store.getQuote(one.quote.id)?.providerData).toEqual({ privateProof: 'SERVER_ONLY_VALUE', ...patch });
    const reopened = new Store(path); cleanup.push(() => reopened.close());
    const resumed = new OrderService(reopened, env.provider, { tokenSecret: secret }); cleanup.push(() => resumed.stop());
    env.provider.trackOrder = vi.fn(async (order): Promise<TrackingUpdate> => {
      expect(order.providerData).toEqual({ privateProof: 'SERVER_ONLY_VALUE', ...patch });
      return { status: 'verifying_credit', statusMessage: 'resumed' };
    });
    await resumed.refresh(one.order.id, one.accessToken);
    expect(env.provider.trackOrder).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await resumed.get(one.order.id, one.accessToken))).not.toContain('PRIVATE_CURSOR_VALUE');
  });
  it('rejects malformed private state patches without overwriting the saved quote', async () => {
    const env = setup(); const one = await newOrder(env);
    for (const patch of [JSON.parse('{"__proto__":{"polluted":true}}'), { cursor: Number.NaN }, { cursor: 'x'.repeat(65_537) }]) {
      expect(() => env.store.patchQuoteProviderData(one.quote.id, patch)).toThrow('内部跟踪状态');
    }
    expect(env.store.getQuote(one.quote.id)?.providerData).toEqual({ privateProof: 'SERVER_ONLY_VALUE' });
  });
});

describe('HTTP boundary', () => {
  async function httpSetup() {
    const env = setup();
    const app = createApp(env.service, { allowedOrigins: ['https://funding.example'], logging: false });
    const server: Server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolve(instance));
    });
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    return { ...env, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }
  it('enforces origin, body schema, auth isolation, and does not expose private provider data', async () => {
    const env = await httpSetup();
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${env.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect((await post('/api/quotes', request, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post('/api/quotes', { ...request, providerData: {} })).status).toBe(400);
    const quoteResponse = await post('/api/quotes', request); const quote = await quoteResponse.json();
    expect(quoteResponse.status).toBe(201); expect(quote.providerData).toBeUndefined();
    const orderResponse = await post('/api/orders', { quoteId: quote.id }, { 'idempotency-key': 'http-idempotency-12345' });
    const { order, accessToken } = await orderResponse.json();
    expect((await fetch(`${env.base}/api/orders/${order.id}`)).status).toBe(401);
    expect((await fetch(`${env.base}/api/orders/${order.id}`, { headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status).toBe(404);
    const read = await fetch(`${env.base}/api/orders/${order.id}`, { headers: { authorization: `Bearer ${accessToken}` } });
    expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.headers.get('content-security-policy')?.split(';').find(rule => rule.startsWith('connect-src')))
      .toBe("connect-src 'self' https://api.trongrid.io https://api.tronstack.io https://tron-rpc.publicnode.com");
    expect(await read.text()).not.toContain('SERVER_ONLY_VALUE');
    await env.service.submit(order.id, accessToken, tx);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'verifying_credit', statusMessage: 'scanning', providerDataPatch: { creditScan: { startTime: 12345 }, unknownPrivateField: 'NEVER_IN_HTTP' } }));
    const refresh = await post(`/api/orders/${order.id}/refresh`, {}, { authorization: `Bearer ${accessToken}` });
    expect(refresh.status).toBe(200);
    const refreshed = await refresh.text(); expect(refreshed).not.toContain('providerData'); expect(refreshed).not.toContain('NEVER_IN_HTTP');
    expect(env.store.getQuote(quote.id)?.providerData.unknownPrivateField).toBe('NEVER_IN_HTTP');
    expect((await post(`/api/orders/${order.id}/refresh`, { providerDataPatch: { creditScan: { startTime: 0 } } }, { authorization: `Bearer ${accessToken}` })).status).toBe(400);
  });
  it('sanitizes upstream exceptions and validates JSON size and content type', async () => {
    const env = await httpSetup();
    env.provider.getQuote = async () => { throw new Error('secret-key=123456789 stacktrace'); };
    const failed = await fetch(`${env.base}/api/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    const body = await failed.json(); expect(failed.status).toBe(502); expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('secret-key');
    const large = await fetch(`${env.base}/api/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(20_000) }) });
    expect(large.status).toBe(413);
    expect((await fetch(`${env.base}/api/quotes`, { method: 'POST', body: '{}' })).status).toBe(415);
    env.provider.getQuote = async () => { throw new UpstreamError('INVALID_ADDRESS', 'do-not-echo-provider-input'); };
    const invalid = await fetch(`${env.base}/api/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(invalid.status).toBe(400); expect(await invalid.text()).not.toContain('do-not-echo');
  });
});
