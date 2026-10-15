// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/App.js';
import { api, persistSavedOrder, savedOrderForPayment, type SavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { AppConfig, Order, Quote } from '../shared/types.js';

// Only remote APIs and injected wallets are substituted. The actual App,
// recovery state, history selection and progress component execute in jsdom.
// These fixtures are not evidence of a real transfer or production deployment.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, connectTron: vi.fn(), connectEvm: vi.fn(), getEvmChain: vi.fn(), sourceBalance: vi.fn(),
    sourceNativeBalance: vi.fn(), getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), preflightPayment: vi.fn(), listEvmWallets: vi.fn(),
    evmProvider: vi.fn(() => { throw new Error('No injected wallet in isolated progress tests'); }) };
});
const route = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'ethereum-usdt-hypercore')!.route;
const recipient = '0x1111111111111111111111111111111111111111';
const sourceHash = `0x${'ab'.repeat(32)}`;
const destinationHash = `0x${'cd'.repeat(32)}`;
const beganAt = '2026-10-15T10:00:00.000Z';
const successAt = '2026-10-15T10:19:50.000Z';
const attemptAt = '2026-10-15T10:19:55.000Z';
const updatedAt = '2026-10-15T10:19:59.000Z';
const recoveredAt = '2026-10-15T10:20:04.000Z';
type ProgressOrder = Order & { trackingCheck?: { attemptedAt: string; succeededAt?: string; result: 'ok' | 'unavailable' } };
const config: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [route], limits: { minAmount: '10', maxAmount: '100' }, paused: false };
class IsolatedStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, String(value)); }
  removeItem(key: string) { this.entries.delete(key); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
let host: HTMLDivElement; let root: Root; let orders: Map<string, ProgressOrder>; let sequence: number; let online: boolean;
function quote(amount = '25'): Quote {
  return { id: `TEST_ONLY_PROGRESS_QUOTE_${++sequence}`, routeId: route.id, sourceAddress: recipient, recipient,
    amount, amountBaseUnits: (BigInt(amount) * 1000000n).toString(), expectedReceive: '24.7', minReceive: '24.6', expiresAt: '2026-10-15T10:02:00.000Z',
    provider: 'Relay', fees: [], warnings: ['TEST_ONLY_FINALITY_WARNING'], transaction: { kind: 'evm', chainId: 1, to: recipient, data: '0x', value: '0' } };
}
function save(changes: Partial<ProgressOrder> = {}, submission?: SavedOrder['submission']) {
  const order: ProgressOrder = { id: `progress-${++sequence}`, createdAt: beganAt, updatedAt, quote: quote(), sourceTxHash: sourceHash,
    status: 'bridging', statusMessage: 'TEST_ONLY_SOURCE_VERIFIED', events: [{ at: beganAt, status: 'source_pending', message: 'TEST_ONLY_PENDING' },
      { at: successAt, status: 'bridging', message: 'TEST_ONLY_SOURCE_VERIFIED' }],
    trackingCheck: { attemptedAt: successAt, succeededAt: successAt, result: 'ok' }, ...changes };
  const saved: SavedOrder = { id: order.id, accessToken: `TEST_ONLY_TOKEN_${order.id}`, createdAt: order.createdAt, ...(submission ? { submission } : {}) };
  orders.set(order.id, order); persistSavedOrder(saved); return { order, saved };
}
function complete(changes: Partial<ProgressOrder> = {}): Partial<ProgressOrder> {
  return { status: 'completed', destinationTxHash: destinationHash, creditedAmount: '24.65', statusMessage: 'TEST_ONLY_COMPLETE_CLAIM',
    events: [{ at: beganAt, status: 'bridging', message: 'TEST_ONLY_SOURCE_VERIFIED' }, { at: successAt, status: 'completed', message: 'TEST_ONLY_COMPLETE_EVENT' }],
    evidence: [{ type: 'ethereum_finalized_transfer', reference: sourceHash }, { type: 'relay_request', reference: 'TEST_ONLY_RELAY_ID' },
      { type: 'hypercore_credit', reference: `${recipient}:${destinationHash}` }], ...changes };
}
function buttons(pattern: RegExp) { return [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => pattern.test(node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '')); }
function button(pattern: RegExp) { const matches = buttons(pattern); expect(matches, `button ${pattern}`).toHaveLength(1); return matches[0]!; }
function card() { const node = host.querySelector<HTMLElement>('[aria-label="订单核验进度"]'); expect(node).not.toBeNull(); return node!; }
function cardText() { return card().textContent ?? ''; }
function freshness() { const node = card().querySelector<HTMLElement>('[aria-label="状态查询时间"]'); expect(node).not.toBeNull(); return node!; }
function steps() { const nodes = [...card().querySelectorAll<HTMLElement>('.progress-step')]; expect(nodes).toHaveLength(3); return nodes; }
function status() { return host.querySelector('.status-badge')?.textContent ?? ''; }
function renderedTime(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function expectSuccessfulTime(value: string) {
  expect(freshness().textContent).toMatch(/最近成功.*查询|上次成功.*查询|最近.*查询成功/);
  expect(freshness().querySelector('time')?.dateTime).toBe(value);
  expect(freshness().textContent).toContain(renderedTime(value));
}
function expectNoNewPayment() {
  expect(buttons(/钱包签名并付款|授权本笔额度|获取实时入金报价|确认报价.*创建订单|开始新入金/).every(node => node.disabled)).toBe(true);
}
async function flush() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); }
async function render() { await act(async () => root.render(<App />)); await flush(); }
async function click(node: HTMLElement) { await act(async () => node.click()); await flush(); }
async function tick(ms = 6_001) { await act(async () => vi.advanceTimersByTimeAsync(ms)); await flush(); }
async function connectivity(next: boolean) { online = next; await act(async () => window.dispatchEvent(new Event(next ? 'online' : 'offline'))); await flush(); }
async function openHistoryOrder(id: string) {
  await click(button(/^订单记录$/));
  const target = [...host.querySelectorAll<HTMLButtonElement>('.history-panel .saved-order')].find(node => node.textContent?.includes(id));
  expect(target, `history order ${id}`).toBeTruthy(); await click(target!);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }); vi.setSystemTime(new Date('2026-10-15T10:20:00.000Z'));
  vi.stubGlobal('localStorage', new IsolatedStorage()); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No real HTTP in progress tests'); }));
  orders = new Map(); sequence = 0; online = true;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => callback({ name: 'TEST_ONLY_LOCK', mode: 'exclusive' } as Lock) } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(wallets.listEvmWallets).mockReturnValue([]); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0'); vi.mocked(wallets.sourceBalance).mockResolvedValue('0');
  vi.spyOn(api, 'config').mockResolvedValue(config);
  vi.spyOn(api, 'account').mockResolvedValue({ address: recipient, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: beganAt });
  vi.spyOn(api, 'order').mockImplementation(async id => { const order = orders.get(id); if (!order) throw new Error('No test order'); return structuredClone(order); });
  vi.spyOn(api, 'refresh').mockImplementation(async id => { const order = orders.get(id); if (!order) throw new Error('No test order'); return structuredClone(order); });
  for (const name of ['quote', 'createOrder', 'report'] as const) vi.spyOn(api, name).mockRejectedValue(new Error('Unexpected funding mutation in progress test'));
});
afterEach(async () => {
  expect(wallets.connectEvm).not.toHaveBeenCalled(); expect(wallets.connectTron).not.toHaveBeenCalled(); expect(wallets.approveExact).not.toHaveBeenCalled();
  expect(wallets.sendPayment).not.toHaveBeenCalled(); expect(wallets.preflightPayment).not.toHaveBeenCalled();
  expect(api.quote).not.toHaveBeenCalled(); expect(api.createOrder).not.toHaveBeenCalled(); expect(api.report).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, 'locks'); Reflect.deleteProperty(navigator, 'onLine');
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('order evidence and tracking freshness in the actual App', () => {
  it('restores legacy records with unknown successful-query time instead of substituting updatedAt', async () => {
    save({ trackingCheck: undefined }); await render();
    expect(host.querySelector('main h1')?.textContent).toBe('入金进度'); expect(cardText()).toMatch(/查询.*未知|尚无.*查询|未.*记录.*查询|尚未.*查询/);
    expect(cardText()).not.toContain(renderedTime(updatedAt)); expect(cardText()).not.toContain('最近更新'); expectNoNewPayment();
  });
  it('shows a successful pending query separately from source confirmation or completed funding', async () => {
    save({ status: 'source_pending', statusMessage: 'TEST_ONLY_PENDING', events: [{ at: beganAt, status: 'source_pending', message: 'TEST_ONLY_PENDING' }] }); await render();
    expectSuccessfulTime(successAt); expect(steps()[0]!.classList.contains('done')).toBe(false); expect(steps()[0]!.textContent).toContain('等待');
    expect(status()).not.toContain('已核实到账'); expect(host.querySelector('.receive-label')?.textContent).toBe('预计到账'); expectNoNewPayment();
  });
  it('retains the last successful query time when the server cannot finish its latest tracking query', async () => {
    save({ trackingCheck: { attemptedAt: attemptAt, succeededAt: successAt, result: 'unavailable' }, statusMessage: '暂时无法核验最新进度，系统会继续查询；请勿重复付款。' }); await render();
    expectSuccessfulTime(successAt); expect(card().querySelector('.progress-query-warning')?.textContent).toMatch(/查询.*未完成|查询.*失败|查询.*不可用|未能.*查询|无法.*最新|未能.*完成/);
    expect(cardText()).not.toContain(renderedTime(updatedAt)); expect(steps()[0]!.classList.contains('done')).toBe(true); expectNoNewPayment();
  });
  it('does not fabricate a prior successful query time when the first query failed', async () => {
    save({ trackingCheck: { attemptedAt: attemptAt, result: 'unavailable' } }); await render();
    expect(cardText()).toMatch(/查询.*未知|尚无.*查询|未.*记录.*查询|尚未.*查询/);
    expect(freshness().textContent).not.toContain(renderedTime(updatedAt)); expect(freshness().textContent).not.toContain(renderedTime(successAt)); expectNoNewPayment();
  });
  it.each([
    { attemptedAt: 'not-a-date', succeededAt: successAt, result: 'ok' as const },
    { attemptedAt: '2026-10-16T10:20:00.000Z', succeededAt: successAt, result: 'ok' as const },
    { attemptedAt: successAt, succeededAt: attemptAt, result: 'ok' as const },
  ])('does not present a malformed or inconsistent query clock as fresh: %j', async trackingCheck => {
    save({ trackingCheck }); await render();
    expect(freshness().querySelector('time')).toBeNull(); expect(card().querySelector('.progress-query-warning')?.textContent).toContain('尚无可用的状态查询时间');
    expect(steps()[0]!.classList.contains('done')).toBe(true); expectNoNewPayment();
  });
  it('marks an unchanged server tracking result stale even when repeated browser GET requests succeed', async () => {
    save(); await render(); expect(card().querySelector('.progress-query-warning')).toBeNull();
    await tick(51_001); expect(api.order).toHaveBeenCalled(); expectSuccessfulTime(successAt);
    expect(card().querySelector('.progress-query-warning')?.textContent).toMatch(/超过.*分钟.*未取得新的状态查询结果/);
    expect(steps()[0]!.classList.contains('done')).toBe(true); expectNoNewPayment();
  });
  it('keeps source verification visible in attention without representing the route or HL credit as complete', async () => {
    save({ status: 'attention', statusMessage: 'TEST_ONLY_ROUTE_REQUIRES_REVIEW', events: [
      { at: beganAt, status: 'source_pending', message: 'TEST_ONLY_PENDING' }, { at: successAt, status: 'bridging', message: 'TEST_ONLY_SOURCE_VERIFIED' },
      { at: attemptAt, status: 'attention', message: 'TEST_ONLY_ROUTE_REQUIRES_REVIEW' }], trackingCheck: { attemptedAt: attemptAt, succeededAt: attemptAt, result: 'ok' } });
    await render(); expect(steps()[0]!.classList.contains('done')).toBe(true); expect(steps()[0]!.textContent).toMatch(/已.*核验|已.*确认/);
    expect(steps()[2]!.classList.contains('done')).toBe(false); expect(status()).toContain('核查'); expectNoNewPayment();
  });
  it('labels a route report separately and does not turn a Relay reference into verified HyperCore credit', async () => {
    save({ status: 'verifying_credit', evidence: [{ type: 'relay_request', reference: 'TEST_ONLY_RELAY_REQUEST' }], events: [
      { at: beganAt, status: 'bridging', message: 'TEST_ONLY_SOURCE_VERIFIED' }, { at: successAt, status: 'verifying_credit', message: 'TEST_ONLY_ROUTE_REPORTED' }] });
    await render(); expect(cardText()).toMatch(/路由.*报告|报告.*路由/); expect(cardText()).toMatch(/不代表.*到账|不能.*到账|仍.*核验|未.*确认.*到账/);
    expect(steps()[2]!.classList.contains('done')).toBe(false); expect(status()).not.toContain('已核实到账'); expectNoNewPayment();
  });
  it.each(['missing-evidence', 'missing-amount', 'underpaid', 'invalid-hash', 'wrong-recipient', 'wrong-hash'] as const)('does not trust a completed status or history event with %s', async kind => {
    const changes = complete();
    if (kind === 'missing-evidence') changes.evidence = [];
    if (kind === 'missing-amount') changes.creditedAmount = undefined;
    if (kind === 'underpaid') changes.creditedAmount = '24.59999999';
    if (kind === 'invalid-hash') changes.destinationTxHash = 'not-a-hash';
    if (kind === 'wrong-recipient') changes.evidence = [{ type: 'hypercore_credit', reference: `0x${'22'.repeat(20)}:${destinationHash}` }];
    if (kind === 'wrong-hash') changes.evidence = [{ type: 'hypercore_credit', reference: `${recipient}:0x${'33'.repeat(32)}` }];
    save(changes); await render();
    expect(status()).not.toContain('已核实到账'); expect(steps()[2]!.classList.contains('done')).toBe(false); expect(host.querySelector('.receive-label')?.textContent).toBe('预计到账');
    expect(host.textContent).not.toContain('TEST_ONLY_COMPLETE_CLAIM'); expect(host.textContent).not.toContain('TEST_ONLY_COMPLETE_EVENT'); expectNoNewPayment();
  });
  it('shows actual credited amount only with the matching recipient, destination hash and sufficient amount', async () => {
    save(complete()); await render(); expect(status()).toBe('已核实到账'); expect(host.querySelector('.receive-label')?.textContent).toBe('实际到账');
    expect(host.querySelector('.hero-amount')?.textContent).toContain('24.65'); expect(steps()[2]!.classList.contains('done')).toBe(true);
    expectSuccessfulTime(successAt); expect(cardText()).toMatch(/查询成功.*不代表资金已到账/);
    const calls = vi.mocked(api.order).mock.calls.length; await tick(12_001); expect(api.order).toHaveBeenCalledTimes(calls);
  });
  it('preserves confirmed progress and successful-query time when browser polling fails, then clears stale status after recovery', async () => {
    const { order } = save(); await render();
    vi.mocked(api.order).mockRejectedValue(new Error('TEST_ONLY_BROWSER_READ_FAILURE')); await tick();
    expect(steps()[0]!.classList.contains('done')).toBe(true); expectSuccessfulTime(successAt); expect(cardText()).toMatch(/上次.*记录|不是实时|未能.*获取|读取.*失败|未能.*读取/); expectNoNewPayment();
    orders.set(order.id, { ...order, trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' } });
    vi.mocked(api.order).mockImplementation(async id => structuredClone(orders.get(id)!)); await tick();
    expectSuccessfulTime(recoveredAt); expect(cardText()).not.toMatch(/读取.*失败|未能.*读取|不是实时|未能.*获取/);
  });
  it('preserves progress and marks stale browser data after a manual refresh failure', async () => {
    save(); await render(); vi.mocked(api.refresh).mockRejectedValue(new Error('TEST_ONLY_REFRESH_FAILURE'));
    await click(button(/刷新订单核验/)); expect(steps()[0]!.classList.contains('done')).toBe(true); expectSuccessfulTime(successAt);
    expect(cardText()).toMatch(/上次.*记录|不是实时|未能.*获取|读取.*失败|未能.*读取/); expectNoNewPayment();
  });
  it('rejects a manual refresh response for another order without replacing the current progress', async () => {
    const { order } = save(); await render();
    vi.mocked(api.refresh).mockResolvedValue({ ...order, id: 'TEST_ONLY_WRONG_ORDER', statusMessage: 'TEST_ONLY_WRONG_RESPONSE' });
    await click(button(/刷新订单核验/)); expect(host.textContent).toContain(order.id); expect(host.textContent).not.toContain('TEST_ONLY_WRONG_RESPONSE');
    expect(card().querySelector('.progress-query-warning')?.textContent).toContain('无法读取最新订单'); expectSuccessfulTime(successAt); expectNoNewPayment();
  });
  it('does not let an older GET roll back a successful manual refresh of the same order', async () => {
    const { order } = save(); await render(); const pending = deferred<ProgressOrder>();
    vi.mocked(api.order).mockImplementationOnce(() => pending.promise); await tick();
    const next: ProgressOrder = { ...order, status: 'verifying_credit', statusMessage: 'TEST_ONLY_NEW_ROUTE_REPORT',
      trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' } };
    orders.set(order.id, next); await click(button(/刷新订单核验/)); expectSuccessfulTime(recoveredAt); expect(cardText()).toContain('TEST_ONLY_NEW_ROUTE_REPORT');
    await act(async () => pending.resolve({ ...order, statusMessage: 'TEST_ONLY_LATE_GET_OLD_STATE' })); await flush();
    expectSuccessfulTime(recoveredAt); expect(cardText()).toContain('TEST_ONLY_NEW_ROUTE_REPORT'); expect(cardText()).not.toContain('TEST_ONLY_LATE_GET_OLD_STATE'); expectNoNewPayment();
  });
  it('does not let an older GET or unchanged saved record erase a failed manual tracking refresh', async () => {
    const { order } = save(); await render(); const pending = deferred<ProgressOrder>();
    vi.mocked(api.order).mockImplementationOnce(() => pending.promise); await tick();
    vi.mocked(api.refresh).mockRejectedValue(new Error('TEST_ONLY_NEW_REFRESH_FAILURE')); await click(button(/刷新订单核验/));
    await act(async () => pending.resolve(order)); await flush(); expect(card().querySelector('.progress-query-warning')?.textContent).toContain('无法读取最新订单');
    await tick(); expect(card().querySelector('.progress-query-warning')?.textContent).toContain('无法读取最新订单'); expectSuccessfulTime(successAt);
    orders.set(order.id, { ...order, trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' } }); await tick();
    expectSuccessfulTime(recoveredAt); expect(card().querySelector('.progress-query-warning')?.textContent ?? '').not.toContain('无法读取最新订单'); expectNoNewPayment();
  });
  it('retains a manual refresh failure through a later GET failure and unchanged GET success until tracking advances', async () => {
    const { order } = save(); await render(); const readsBefore = vi.mocked(api.order).mock.calls.length;
    vi.mocked(api.refresh).mockRejectedValue(new Error('TEST_ONLY_MANUAL_TRACKING_FAILURE'));
    vi.mocked(api.order).mockRejectedValue(new Error('TEST_ONLY_SUBSEQUENT_BROWSER_FAILURE'));
    await click(button(/刷新订单核验/));
    expect(vi.mocked(api.order).mock.calls.length).toBeGreaterThan(readsBefore);
    expect(card().querySelector('.progress-query-warning')?.textContent).toContain('无法读取最新订单'); expectSuccessfulTime(successAt);
    vi.mocked(api.order).mockResolvedValue(structuredClone(order)); await tick();
    expect(card().querySelector('.progress-query-warning')?.textContent).toContain('无法读取最新订单'); expectSuccessfulTime(successAt);
    expect(steps()[0]!.classList.contains('done')).toBe(true); expectNoNewPayment();
    vi.mocked(api.order).mockResolvedValue({ ...order, trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' } }); await tick();
    expectSuccessfulTime(recoveredAt); expect(card().querySelector('.progress-query-warning')).toBeNull(); expectNoNewPayment();
  });
  it('keeps source facts visible offline and refreshes reads on reconnect without another payment', async () => {
    const { order } = save(); await render(); await connectivity(false);
    expect(steps()[0]!.classList.contains('done')).toBe(true); expectSuccessfulTime(successAt); expect(cardText()).toMatch(/离线|不是实时/);
    expect(button(/刷新订单核验/).disabled).toBe(true); expectNoNewPayment();
    orders.set(order.id, { ...order, trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' } });
    await connectivity(true); expectSuccessfulTime(recoveredAt); expect(cardText()).not.toMatch(/离线|不是实时/); expect(api.refresh).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)('does not let an old order late %s overwrite the current order progress or freshness', async outcome => {
    const second = save({ quote: quote('45'), trackingCheck: { attemptedAt: recoveredAt, succeededAt: recoveredAt, result: 'ok' }, statusMessage: 'TEST_ONLY_SECOND_ORDER' });
    const first = save({ quote: quote('35'), statusMessage: 'TEST_ONLY_FIRST_ORDER' }); await render(); expect(host.textContent).toContain('35');
    const pending = deferred<ProgressOrder>();
    vi.mocked(api.order).mockImplementation(async id => id === first.order.id ? pending.promise : structuredClone(orders.get(id)!)); await tick();
    await openHistoryOrder(second.order.id); expectSuccessfulTime(recoveredAt); expect(cardText()).toContain('TEST_ONLY_SECOND_ORDER');
    await act(async () => { if (outcome === 'success') pending.resolve({ ...first.order, statusMessage: 'TEST_ONLY_LATE_OLD_ORDER' }); else pending.reject(new Error('TEST_ONLY_LATE_OLD_FAILURE')); }); await flush();
    expectSuccessfulTime(recoveredAt); expect(cardText()).toContain('TEST_ONLY_SECOND_ORDER'); expect(host.textContent).not.toContain('TEST_ONLY_LATE_OLD_ORDER');
    expect(host.textContent).not.toContain('TEST_ONLY_LATE_OLD_FAILURE'); expect(cardText()).not.toMatch(/读取.*失败|未能.*读取|不是实时/); expectNoNewPayment();
  });
  it('restores unknown local payment without inventing finalized source evidence or permitting a retry payment', async () => {
    const { order } = save({ status: 'awaiting_signature', sourceTxHash: undefined, events: [], trackingCheck: undefined }, { state: 'unknown' }); await render();
    expect(status()).toBe('付款结果待核查'); expect(steps()[0]!.classList.contains('done')).toBe(false); expectNoNewPayment();
    expect(savedOrderForPayment(order.id)?.submission?.state).toBe('unknown'); expect(cardText()).not.toContain(renderedTime(updatedAt));
  });
  it('keeps a locally saved hash pending until the server verifies the source transfer', async () => {
    save({ status: 'expired', sourceTxHash: undefined, events: [], trackingCheck: undefined }, { state: 'submitted', txHash: sourceHash }); await render();
    expect(status()).toBe('交易编号已保留，等待核验'); expect(steps()[0]!.classList.contains('done')).toBe(false);
    expect(cardText()).toContain('签名窗口到期不代表这笔付款失败'); expectNoNewPayment();
  });
});
