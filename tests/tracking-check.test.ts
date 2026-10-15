import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Order, ProviderAdapter, ProviderQuote, QuoteRequest, SourceVerification, TrackingUpdate } from '../shared/types.js';
import { Store } from '../server/store.js';
import { OrderService } from '../server/order-service.js';

// Synthetic providers and isolated SQLite only. No mainnet, HTTP listener or wallet.
const start = Date.UTC(2026, 9, 15, 12);
const source = `0x${'1'.repeat(40)}`;
const recipient = `0x${'2'.repeat(40)}`;
const sourceHash = `0x${'a'.repeat(64)}`;
const destinationHash = `0x${'b'.repeat(64)}`;
const privateValue = 'TEST_ONLY_PRIVATE_UPSTREAM_VALUE';
const secret = 'tracking-test-only-token-secret-12345678901234567890';
const input: QuoteRequest = { routeId: 'tracking-fixture-usdc', amount: '100', sourceAddress: source, recipient };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function setup(path = ':memory:') {
  let clock = start;
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [{ id: input.routeId, label: 'TEST FIXTURE ONLY', sourceChain: 'Arbitrum', sourceChainId: 42161,
      sourceToken: `0x${'3'.repeat(40)}`, symbol: 'USDC', decimals: 6, walletType: 'evm' as const, available: true }]),
    getQuote: vi.fn(async (request: QuoteRequest): Promise<ProviderQuote> => ({ ...request, amountBaseUnits: '100000000', expectedReceive: '99', minReceive: '98',
      expiresAt: new Date(clock + 60_000).toISOString(), provider: 'TEST_FIXTURE_ONLY', fees: [], warnings: [],
      transaction: { kind: 'evm', chainId: 42161, to: `0x${'4'.repeat(40)}`, data: '0x1234', value: '0' }, providerData: { privateValue } })),
    verifySourceTransaction: vi.fn(async (): Promise<SourceVerification> => ({ valid: true, pending: true })),
    trackOrder: vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'bridging', statusMessage: 'TEST_FIXTURE: destination pending' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date(clock).toISOString() })),
  };
  const store = new Store(path);
  const service = new OrderService(store, provider, { tokenSecret: secret, now: () => clock });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.stop(); store.close(); } };
  cleanup.push(close);
  return { provider, store, service, close, advance: (ms = 1000) => { clock += ms; }, time: () => new Date(clock).toISOString() };
}
async function create(env: ReturnType<typeof setup>) {
  const quote = await env.service.quote(input);
  return env.service.create(quote.id, 'tracking-check-idempotency-fixture');
}
function expectCheck(order: Order, attemptedAt: string, result: 'ok' | 'unavailable', succeededAt?: string) {
  expect(order.trackingCheck).toEqual({ attemptedAt, result, ...(succeededAt ? { succeededAt } : {}) });
  expect(JSON.stringify(order)).not.toContain(privateValue);
}

describe('server-owned tracking check freshness', () => {
  it('does not turn create, read, expiry or refresh without a hash into a completed query', async () => {
    const env = setup(); const created = await create(env);
    expect(created.order.trackingCheck).toBeUndefined();
    env.advance();
    expect(await env.service.get(created.order.id, created.accessToken)).toEqual(created.order);
    expect(await env.service.refresh(created.order.id, created.accessToken)).toEqual(created.order);
    env.advance(60_000);
    const expired = await env.service.get(created.order.id, created.accessToken);
    expect(expired.status).toBe('expired'); expect(expired.updatedAt).not.toBe(created.order.updatedAt);
    expect(expired.trackingCheck).toBeUndefined();
    expect((await env.service.refresh(created.order.id)).trackingCheck).toBeUndefined();
    expect(env.provider.verifySourceTransaction).not.toHaveBeenCalled(); expect(env.provider.trackOrder).not.toHaveBeenCalled();
  });

  it('records accepted source verification at completion, and duplicate submission does not renew it', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(2345); return { valid: true, pending: true }; });
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    expectCheck(submitted, env.time(), 'ok', env.time());
    expect(submitted.status).toBe('source_pending');
    env.advance();
    expect(await env.service.submit(created.order.id, created.accessToken, sourceHash)).toEqual(submitted);
    expect(env.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
  });

  it('refreshes successful pending checks without manufacturing financial progress events', async () => {
    const env = setup(); const created = await create(env);
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(3000); return { valid: true, pending: true }; });
    const first = await env.service.refresh(created.order.id);
    expectCheck(first, env.time(), 'ok', env.time());
    const second = await env.service.refresh(created.order.id);
    expectCheck(second, env.time(), 'ok', env.time());
    expect(second.trackingCheck!.succeededAt).not.toBe(first.trackingCheck!.succeededAt);
    expect(second.events).toEqual(submitted.events);
    expect(second.status).toBe('source_pending'); expect(second.destinationTxHash).toBeUndefined();
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
    expect(env.store.getOrder(created.order.id)?.order).toEqual(second);
  });

  it('preserves last success through a query failure, GET stays unchanged, and pending recovery clears stale error text', async () => {
    const env = setup(); const created = await create(env);
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    const previousSuccess = submitted.trackingCheck!.succeededAt;
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(5000); throw new Error(privateValue); });
    const failed = await env.service.refresh(created.order.id);
    expectCheck(failed, env.time(), 'unavailable', previousSuccess);
    expect(failed.status).toBe('source_pending'); expect(failed.sourceTxHash).toBe(sourceHash);
    expect(failed.statusMessage).toContain('请勿重复付款'); expect(env.store.pollFailures(created.order.id)).toBe(1);
    env.advance();
    expect(await env.service.get(created.order.id, created.accessToken)).toEqual(failed);
    expect(env.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(2000); return { valid: true, pending: true }; });
    const recovered = await env.service.refresh(created.order.id);
    expectCheck(recovered, env.time(), 'ok', env.time());
    expect(recovered.status).toBe('source_pending'); expect(recovered.statusMessage).not.toContain('暂时无法');
    expect(recovered.statusMessage).toContain('尚未确认资金到账'); expect(env.store.pollFailures(created.order.id)).toBe(0);
  });

  it('keeps confirmed source facts when the subsequent route query fails, then recovers independently', async () => {
    const env = setup(); const created = await create(env);
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(1000); return { valid: true, pending: false, providerOrderId: 'test-provider-id' }; });
    env.provider.trackOrder = vi.fn(async () => { env.advance(4000); throw new Error(privateValue); });
    const failed = await env.service.refresh(created.order.id);
    expectCheck(failed, env.time(), 'unavailable', submitted.trackingCheck!.succeededAt);
    expect(failed.status).toBe('bridging'); expect(failed.events.some(event => event.status === 'bridging')).toBe(true);
    expect(failed.providerOrderId).toBe('test-provider-id'); expect(failed.sourceTxHash).toBe(sourceHash);
    expect(failed.destinationTxHash).toBeUndefined(); expect(failed.creditedAmount).toBeUndefined();
    env.provider.trackOrder = vi.fn(async () => { env.advance(2000); return { status: 'verifying_credit', statusMessage: 'TEST_FIXTURE: awaiting attributable credit',
      destinationTxHash: destinationHash, evidence: [{ type: 'relay_status', reference: 'TEST_FIXTURE_ONLY' }] } as TrackingUpdate; });
    const recovered = await env.service.refresh(created.order.id);
    expectCheck(recovered, env.time(), 'ok', env.time());
    expect(recovered.status).toBe('verifying_credit'); expect(recovered.evidence).toHaveLength(1);
    expect(env.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
  });

  it('treats an explicit source mismatch as a successful check that needs attention, not completed funds', async () => {
    const env = setup(); const created = await create(env);
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(); return { valid: false, reason: privateValue }; });
    const checked = await env.service.refresh(created.order.id);
    expectCheck(checked, env.time(), 'ok', env.time());
    expect(checked.status).toBe('attention'); expect(checked.creditedAmount).toBeUndefined();
    expect(checked.events.some(event => event.status === 'bridging')).toBe(false);
    expect(env.provider.trackOrder).not.toHaveBeenCalled();
  });

  it('records explicit route attention as successful without erasing confirmed source history', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { env.advance(); return { status: 'attention', statusMessage: 'TEST_FIXTURE: requires review' }; });
    const checked = await env.service.refresh(created.order.id);
    expectCheck(checked, env.time(), 'ok', env.time());
    expect(checked.status).toBe('attention'); expect(checked.events.some(event => event.status === 'bridging')).toBe(true);
    expect(checked.creditedAmount).toBeUndefined();
  });

  it('keeps the existing bound-credit completion guard and never renews a completed order on refresh or read', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { env.advance(); return { status: 'completed', statusMessage: 'TEST_FIXTURE: unbound claim', destinationTxHash: destinationHash, creditedAmount: '99' }; });
    const unbound = await env.service.refresh(created.order.id);
    expectCheck(unbound, env.time(), 'ok', env.time()); expect(unbound.status).toBe('verifying_credit');
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { env.advance(); return { status: 'completed', statusMessage: 'TEST_FIXTURE: bound credit', destinationTxHash: destinationHash, creditedAmount: '99',
      evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${destinationHash}` }] }; });
    const completed = await env.service.refresh(created.order.id);
    expectCheck(completed, env.time(), 'ok', env.time()); expect(completed.status).toBe('completed');
    env.advance(20_000);
    expect(await env.service.refresh(created.order.id)).toEqual(completed);
    expect(await env.service.get(created.order.id, created.accessToken)).toEqual(completed);
    expect(env.provider.trackOrder).toHaveBeenCalledTimes(1);
  });

  it('updates check freshness for a valid lower-stage response without regressing confirmed progress', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'verifying_credit', statusMessage: 'TEST_FIXTURE: verifying' }));
    const verifying = await env.service.refresh(created.order.id);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { env.advance(); return { status: 'bridging', statusMessage: 'TEST_FIXTURE: old stage' }; });
    const checked = await env.service.refresh(created.order.id);
    expectCheck(checked, env.time(), 'ok', env.time());
    expect(checked.status).toBe('verifying_credit'); expect(checked.events.slice(0, verifying.events.length)).toEqual(verifying.events);
    expect(checked.statusMessage).toContain('与已确认进度不一致');
  });

  it('replaces a stale outage message after a successful lower-stage result while retaining confirmed evidence', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => ({ status: 'verifying_credit', statusMessage: 'TEST_FIXTURE: destination seen',
      destinationTxHash: destinationHash, evidence: [{ type: 'relay_destination', reference: destinationHash }] }));
    const verified = await env.service.refresh(created.order.id);
    env.provider.trackOrder = vi.fn(async () => { env.advance(); throw new Error(privateValue); });
    const failed = await env.service.refresh(created.order.id);
    expect(failed.statusMessage).toContain('暂时无法');
    expectCheck(failed, env.time(), 'unavailable', verified.trackingCheck!.succeededAt);
    env.provider.trackOrder = vi.fn(async (): Promise<TrackingUpdate> => { env.advance(); return { status: 'source_pending', statusMessage: 'TEST_FIXTURE: lower source observation' }; });
    const recovered = await env.service.refresh(created.order.id);
    expectCheck(recovered, env.time(), 'ok', env.time());
    expect(recovered.statusMessage).not.toContain('暂时无法');
    expect(recovered.statusMessage).toContain('已取得查询结果');
    expect(recovered.statusMessage).toContain('与已确认进度不一致');
    expect(recovered.status).toBe('verifying_credit'); expect(recovered.sourceTxHash).toBe(sourceHash);
    expect(recovered.destinationTxHash).toBe(destinationHash); expect(recovered.evidence).toEqual(verified.evidence);
    expect(recovered.events.slice(0, failed.events.length)).toEqual(failed.events);
    expect(recovered.events.at(-1)!.status).toBe('verifying_credit');
    expect(recovered.creditedAmount).toBeUndefined();
  });

  it('coalesces concurrent refreshes and timestamps the end of the single real query', async () => {
    const env = setup(); const created = await create(env);
    await env.service.submit(created.order.id, created.accessToken, sourceHash);
    let release!: (result: SourceVerification) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    env.provider.verifySourceTransaction = vi.fn(() => new Promise<SourceVerification>(resolve => { release = resolve; entered(); }));
    const first = env.service.refresh(created.order.id, created.accessToken);
    const second = env.service.refresh(created.order.id);
    const third = env.service.refresh(created.order.id, created.accessToken);
    await started;
    await expect(env.service.refresh(created.order.id, 'x'.repeat(43))).rejects.toThrow('访问令牌无效');
    env.advance(7000); release({ valid: true, pending: true });
    const results = await Promise.all([first, second, third]);
    expect(env.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
    for (const result of results) expectCheck(result, env.time(), 'ok', env.time());
    expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
    expect(env.store.getOrder(created.order.id)?.order).toEqual(results[0]);
  });

  it('persists failure and last success through SQLite close/reopen and resumes polling with the original token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'perpex-tracking-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'orders.sqlite'); const env = setup(path); const created = await create(env);
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(); throw new Error(privateValue); });
    const failed = await env.service.refresh(created.order.id); await env.close();
    const resumed = setup(path); resumed.advance(10_000);
    expect(await resumed.service.get(created.order.id, created.accessToken)).toEqual(failed);
    expect(resumed.provider.verifySourceTransaction).not.toHaveBeenCalled();
    resumed.advance(20_000); await resumed.service.tick();
    const recovered = await resumed.service.get(created.order.id, created.accessToken);
    expectCheck(recovered, resumed.time(), 'ok', resumed.time());
    expect(recovered.trackingCheck!.succeededAt).not.toBe(submitted.trackingCheck!.succeededAt);
    expect(resumed.provider.verifySourceTransaction).toHaveBeenCalledTimes(1);
    expect(recovered.status).toBe('source_pending'); expect(recovered.sourceTxHash).toBe(sourceHash);
  });

  it('leaves legacy timestamps unknown and does not invent previous success from updatedAt', async () => {
    const env = setup(); const created = await create(env);
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    const legacy = { ...submitted }; delete legacy.trackingCheck; env.store.updateOrder(legacy);
    env.advance();
    expect((await env.service.get(created.order.id, created.accessToken)).trackingCheck).toBeUndefined();
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(); throw new Error(privateValue); });
    const failed = await env.service.refresh(created.order.id);
    expectCheck(failed, env.time(), 'unavailable'); expect(failed.trackingCheck).not.toHaveProperty('succeededAt');
    env.provider.verifySourceTransaction = vi.fn(async () => { env.advance(); return { valid: true, pending: true }; });
    const checked = await env.service.refresh(created.order.id);
    expectCheck(checked, env.time(), 'ok', env.time());
  });

  it('ignores adapter-supplied timestamps and does not publish private cursor errors', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    const submitted = await env.service.submit(created.order.id, created.accessToken, sourceHash);
    env.provider.trackOrder = vi.fn(async () => { env.advance(); return { status: 'bridging', statusMessage: 'TEST_FIXTURE: valid result',
      trackingCheck: { attemptedAt: '1900-01-01', succeededAt: '1900-01-01', result: 'ok' },
      providerDataPatch: { badCursor: Number.NaN, privateValue } } as TrackingUpdate; });
    const failed = await env.service.refresh(created.order.id);
    expectCheck(failed, env.time(), 'unavailable', submitted.trackingCheck!.succeededAt);
    expect(failed.status).toBe('bridging'); expect(JSON.stringify(failed)).not.toContain('1900');
  });

  it('does not bind rejected hashes or fabricate accepted-order check records', async () => {
    const env = setup(); const created = await create(env);
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: false, reason: 'TEST_FIXTURE: wrong transfer' }));
    await expect(env.service.submit(created.order.id, created.accessToken, sourceHash)).rejects.toThrow('wrong transfer');
    env.provider.verifySourceTransaction = vi.fn(async () => { throw new Error(privateValue); });
    await expect(env.service.submit(created.order.id, created.accessToken, sourceHash)).rejects.toThrow();
    expect(await env.service.get(created.order.id, created.accessToken)).toEqual(created.order);
  });
});
