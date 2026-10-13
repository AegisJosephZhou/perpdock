// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import App from '../client/App.js';
import { api, loadSavedOrders, persistSavedOrder, savedOrderForPayment, type SavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import type { AppConfig, Order, Quote, QuoteRequest, Route } from '../shared/types.js';

// These substitutes are confined to jsdom tests. The real App, storage, payment
// coordinator, validation and Web Lock sequence still execute.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, connectTron: vi.fn(), connectEvm: vi.fn(), getEvmChain: vi.fn(), sourceBalance: vi.fn(),
    getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), sourceNativeBalance: vi.fn(), preflightPayment: vi.fn(), listEvmWallets: vi.fn(),
    evmProvider: vi.fn(() => { throw new Error('No injected EVM provider in isolated test'); }) };
});

const source = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const recipient = '0x1111111111111111111111111111111111111111';
const txHash = 'ab'.repeat(32);
const destinationHash = `0x${'cd'.repeat(32)}`;
const route: Route = { id: 'tron-usdt-hypercore', label: 'Tron USDT → Hyperliquid Perps USDC', sourceChain: 'Tron',
  sourceChainId: 728126428, sourceToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6, walletType: 'tron', available: true };
const baseConfig: AppConfig = { appName: 'PerpDock', network: 'mainnet', routes: [route], limits: { minAmount: '10', maxAmount: '1000' }, paused: false };
let host: HTMLDivElement;
let root: Root;
let mounted = false;
let orders: Map<string, Order>;
let orderSequence = 0;
class IsolatedStorage implements Storage {
  private readonly entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, String(value)); }
  removeItem(key: string) { this.entries.delete(key); }
  key(index: number) { return [...this.entries.keys()][index] ?? null; }
}

function fixtureQuote(input: Partial<QuoteRequest> = {}): Quote {
  const amount = input.amount ?? '75.25';
  return { id: `ui-quote-${++orderSequence}`, routeId: route.id, sourceAddress: input.sourceAddress ?? source, recipient: input.recipient ?? recipient,
    amount, amountBaseUnits: parseUnits(amount, route.decimals).toString(), expectedReceive: '73.12345678', minReceive: '72.42123456',
    expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay', transaction: { kind: 'tron', transaction: {} },
    approval: { token: route.sourceToken, spender: 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN', amount: parseUnits(amount, route.decimals).toString() },
    fees: [{ label: '源链网络费估算', amount: '6.123456', symbol: 'TRX' }, { label: 'Relay 路由费', amount: '0.111111', symbol: 'USDT' }],
    warnings: ['TEST_ONLY_PROVIDER_WARNING'] };
}
function saveOrder(changes: Partial<Order> = {}, submission?: SavedOrder['submission'], persist = true): { order: Order; saved: SavedOrder } {
  const at = new Date().toISOString();
  const order: Order = { id: `ui-order-${++orderSequence}`, createdAt: at, updatedAt: at, quote: fixtureQuote(),
    status: 'awaiting_signature', statusMessage: '等待用户签名', events: [{ at, status: 'awaiting_signature', message: '等待用户签名' }], ...changes };
  const saved: SavedOrder = { id: order.id, accessToken: `TEST_ONLY_TOKEN_${order.id}`, createdAt: at, ...(submission ? { submission } : {}) };
  orders.set(order.id, order); if (persist) persistSavedOrder(saved);
  return { order, saved };
}
function buttons(pattern: RegExp): HTMLButtonElement[] { return [...host.querySelectorAll('button')].filter(button => pattern.test(button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '')); }
function button(pattern: RegExp): HTMLButtonElement {
  const matches = buttons(pattern);
  expect(matches.length, `Expected one button matching ${pattern}; found ${matches.map(item => item.textContent).join(' | ')}`).toBe(1);
  return matches[0]!;
}
function field(text: string): HTMLInputElement {
  const label = [...host.querySelectorAll('label')].find(node => node.textContent?.includes(text));
  expect(label, `Missing input label ${text}`).toBeTruthy();
  const element = label?.htmlFor ? host.querySelector(`#${label.htmlFor}`) : label?.querySelector('input');
  expect(element instanceof HTMLInputElement, `Label ${text} does not address an input`).toBe(true);
  return element as HTMLInputElement;
}
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function render() { await act(async () => { root.render(<App />); }); mounted = true; await flush(); }
async function click(element: HTMLElement) { await act(async () => { element.click(); }); await flush(); }
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}
async function tick(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); }
async function connect() { await click(button(/^连接钱包$/)); }
async function confirmRecipient() {
  const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  expect(checkboxes.length).toBeGreaterThan(0);
  for (const checkbox of checkboxes) if (!checkbox.checked && !checkbox.disabled) await click(checkbox);
}
async function fillValid() {
  await connect(); await input(field('支付金额'), '75.25'); await input(field('你的 HL 接收地址'), recipient); await confirmRecipient();
}
function pageHeading() { return host.querySelector('main h1')?.textContent ?? host.querySelector('h1')?.textContent ?? ''; }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  // Node 25 also exposes a storage global. Keep test recovery state in memory,
  // never in Node's optional filesystem-backed localStorage.
  vi.stubGlobal('localStorage', new IsolatedStorage());
  localStorage.clear(); orders = new Map(); orderSequence = 0;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = false;
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
    if (held.has(name)) return callback(null); held.add(name);
    try { return await callback({ name, mode: 'exclusive' } as Lock); } finally { held.delete(name); }
  } } });
  vi.mocked(wallets.listEvmWallets).mockReturnValue([]);
  vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('1');
  vi.mocked(wallets.preflightPayment).mockResolvedValue();
  vi.mocked(wallets.connectTron).mockResolvedValue(source);
  vi.mocked(wallets.connectEvm).mockResolvedValue(recipient);
  vi.mocked(wallets.sourceBalance).mockResolvedValue('100.000007');
  vi.mocked(wallets.getAllowance).mockResolvedValue(0n);
  vi.mocked(wallets.approveExact).mockImplementation(async (quote) => { vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(quote.amountBaseUnits)); });
  vi.mocked(wallets.sendPayment).mockImplementation(async (_quote, _route, onHash) => { onHash(txHash); return txHash; });
  vi.spyOn(api, 'config').mockResolvedValue(structuredClone(baseConfig));
  vi.spyOn(api, 'quote').mockImplementation(async request => fixtureQuote(request));
  vi.spyOn(api, 'account').mockResolvedValue({ address: recipient, perpsUsdc: '12.345678', withdrawableUsdc: '11.234567', observedAt: new Date().toISOString() });
  vi.spyOn(api, 'createOrder').mockImplementation(async quoteId => {
    const quote = vi.mocked(api.quote).mock.results.at(-1);
    expect(quote?.type).toBe('return');
    const quoted = await quote!.value;
    expect(quoted.id).toBe(quoteId);
    const created = saveOrder({ quote: quoted }, undefined, false);
    return { order: structuredClone(created.order), accessToken: created.saved.accessToken };
  });
  vi.spyOn(api, 'order').mockImplementation(async id => {
    const value = orders.get(id); if (!value) throw new Error('Order does not exist in isolated test'); return structuredClone(value);
  });
  vi.spyOn(api, 'report').mockImplementation(async (id, _token, hash) => {
    const order = { ...orders.get(id)!, status: 'source_pending' as const, sourceTxHash: hash, statusMessage: '来源付款等待固化' };
    orders.set(id, order); return structuredClone(order);
  });
  vi.spyOn(api, 'refresh').mockImplementation(async id => structuredClone(orders.get(id)!));
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  else root?.unmount();
  host?.remove(); localStorage?.clear?.(); Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('PerpDock isolated UI funding regression', () => {
  it('does not quote without a connected source, a valid recipient, and explicit recipient confirmation', async () => {
    await render();
    expect(button(/获取实时入金报价/).disabled).toBe(true);
    for (const percent of [/^25%$/, /^50%$/, /^全部$/]) expect(button(percent).disabled).toBe(true);
    await connect(); await input(field('支付金额'), '75.25'); await input(field('你的 HL 接收地址'), 'not-an-address');
    expect(button(/获取实时入金报价/).disabled).toBe(true);
    await input(field('你的 HL 接收地址'), recipient);
    expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(api.quote).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
    await confirmRecipient(); expect(button(/获取实时入金报价/).disabled).toBe(false);
  });
  it('renders the exact wallet balance and floors 25/50/all amounts to source precision', async () => {
    await render(); await connect();
    expect(host.textContent).toContain('100.000007');
    await click(button(/^25%$/)); expect(field('支付金额').value).toBe('25.000001');
    await click(button(/^50%$/)); expect(field('支付金额').value).toBe('50.000003');
    await click(button(/^全部$/)); expect(field('支付金额').value).toBe('100.000007');
    expect(host.textContent).toContain('TRX');
  });
  it('caps all at the server maximum and disables shortcuts when balance cannot be read', async () => {
    vi.mocked(wallets.sourceBalance).mockResolvedValueOnce('1234.567891');
    await render(); await connect(); await click(button(/^全部$/));
    expect(field('支付金额').value).toBe('1000');
    vi.mocked(wallets.sourceBalance).mockRejectedValue(new Error('Balance RPC unavailable'));
    await click(button(/重新连接/));
    for (const percent of [/^25%$/, /^50%$/, /^全部$/]) expect(button(percent).disabled).toBe(true);
  });
  it('uses API expected/minimum output without sample values and keeps an unsigned order on the funding page', async () => {
    await render(); await fillValid(); await tick(600);
    expect(api.account).toHaveBeenCalledWith(recipient);
    await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenCalledWith({ routeId: route.id, amount: '75.25', sourceAddress: source, recipient });
    expect(host.textContent).toContain('73.12345678'); expect(host.textContent).toContain('72.42123456');
    expect(host.textContent).toContain('6.123456'); expect(host.textContent).toContain('0.111111');
    await click(button(/确认报价.*创建订单/));
    expect(pageHeading()).toMatch(/存入.*Hyperliquid/i);
    expect(field('支付金额').value).toBe('75.25');
    expect(button(/授权本笔额度/).disabled).toBe(false);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['source_pending', 'bridging', 'verifying_credit', 'attention'] as const)('restores %s on the progress page without exposing a new payment action', async status => {
    const one = saveOrder({ status, sourceTxHash: txHash }); await render();
    expect(pageHeading()).not.toMatch(/存入.*Hyperliquid/i);
    expect(host.textContent).toContain(one.order.quote.amount);
    expect(host.textContent).toContain(one.order.quote.recipient);
    expect(host.textContent).toContain(txHash);
    if (status === 'source_pending') {
      const firstStep = host.querySelector('.progress-step');
      expect(firstStep?.classList.contains('active')).toBe(true);
      expect(firstStep?.classList.contains('done')).toBe(false);
      expect(firstStep?.textContent).toContain('等待源链交易确认，尚不代表到账');
    }
    expect(buttons(/钱包签名并付款/).every(item => item.disabled)).toBe(true);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['awaiting_signature', 'expired'] as const)('recovers a locally saved hash while server is %s without claiming failed payment or allowing another signature', async status => {
    const one = saveOrder({ status, ...(status === 'expired' ? { quote: { ...fixtureQuote(), expiresAt: '2000-01-01T00:00:00.000Z' } } : {}) }, { state: 'submitted', txHash });
    await render();
    expect(pageHeading()).toBe('入金进度');
    expect(host.querySelector('.status-badge')?.textContent).toBe('交易编号已保留，等待核验');
    expect(host.textContent).toContain('签名窗口到期不代表这笔付款失败');
    expect(host.querySelector('.signature-window')).toBeNull();
    expect(buttons(/钱包签名并付款|重新获取报价|获取实时入金报价/)).toHaveLength(0);
    await click(button(/继续核验已提交交易/));
    expect(api.report).toHaveBeenCalledWith(one.order.id, one.saved.accessToken, txHash);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
    expect(savedOrderForPayment(one.order.id)?.submission?.txHash).toBe(txHash);
  });
  it('keeps an unknown local payment recoverable even when the server order read fails', async () => {
    const one = saveOrder({}, { state: 'unknown' }); vi.mocked(api.order).mockRejectedValue(new Error('temporary read outage'));
    await render();
    expect(buttons(/钱包签名并付款|确认报价.*创建订单|获取实时入金报价/).every(item => item.disabled)).toBe(true);
    expect(savedOrderForPayment(one.order.id)?.submission?.state).toBe('unknown');
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['signing', 'unknown'] as const)('keeps a locally %s payment without a hash in recovery instead of starting another payment', async state => {
    const one = saveOrder({}, { state }); await render();
    expect(pageHeading()).toBe('入金进度');
    expect(host.querySelector('.status-badge')?.textContent).toBe(state === 'signing' ? '等待钱包付款结果' : '付款结果待核查');
    expect(host.textContent).toContain('当前订单已阻止再次付款');
    expect(buttons(/钱包签名并付款|获取实时入金报价|确认报价.*创建订单/)).toHaveLength(0);
    expect(savedOrderForPayment(one.order.id)?.submission?.state).toBe(state);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['missing-evidence', 'missing-amount', 'underpaid', 'invalid-hash', 'wrong-recipient', 'wrong-hash'] as const)('never announces verified credit for a completed response with %s', async kind => {
    const evidence = [{ type: 'hypercore_credit', reference: `${recipient}:${destinationHash}` }];
    const base: Partial<Order> = { status: 'completed', sourceTxHash: txHash, destinationTxHash: destinationHash, creditedAmount: '72.99999999', evidence,
      statusMessage: '上游错误宣称已到账', events: [{ at: new Date().toISOString(), status: 'completed', message: '上游事件错误宣称已到账' }] };
    if (kind === 'missing-evidence') delete base.evidence;
    if (kind === 'missing-amount') delete base.creditedAmount;
    if (kind === 'underpaid') base.creditedAmount = '72.42123455';
    if (kind === 'invalid-hash') base.destinationTxHash = 'invalid-hash';
    if (kind === 'wrong-recipient') base.evidence = [{ type: 'hypercore_credit', reference: `0x${'22'.repeat(20)}:${destinationHash}` }];
    if (kind === 'wrong-hash') base.evidence = [{ type: 'hypercore_credit', reference: `${recipient}:0x${'33'.repeat(32)}` }];
    saveOrder(base);
    await render();
    expect(host.querySelector('.status-badge')?.textContent).not.toContain('已核实到账');
    expect(host.querySelector('.receive-label')?.textContent).toBe('预计到账');
    expect(host.textContent).not.toContain('上游错误宣称已到账');
    expect(host.textContent).not.toContain('上游事件错误宣称已到账');
    expect(buttons(/开始新入金/)).toHaveLength(0);
  });
  it('shows actual credited amount after verified completion and retains the completed order when starting a new deposit', async () => {
    const one = saveOrder({ status: 'completed', sourceTxHash: txHash, destinationTxHash: destinationHash, creditedAmount: '72.99999999',
      evidence: [{ type: 'hypercore_credit', reference: `${recipient}:${destinationHash}` }] });
    await render();
    expect(host.querySelector('.status-badge')?.textContent).toBe('已核实到账');
    expect(host.querySelector('.receive-label')?.textContent).toBe('实际到账');
    expect(host.textContent).toContain('72.99999999');
    await click(button(/开始新入金/));
    expect(pageHeading()).toMatch(/存入.*Hyperliquid/i);
    expect(loadSavedOrders().some(item => item.id === one.order.id)).toBe(true);
    await click(button(/^订单记录$/));
    expect(host.textContent).toContain(one.order.id);
  });
  it('permits retry after explicit rejection through the real payment coordinator, then locks progress after broadcast', async () => {
    const one = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(one.order.quote.amountBaseUnits));
    vi.mocked(wallets.sendPayment).mockRejectedValueOnce({ code: 4001, message: 'User rejected' });
    await render(); await connect(); await confirmRecipient();
    await click(button(/钱包签名并付款/));
    expect(wallets.sendPayment).toHaveBeenCalledTimes(1);
    expect(savedOrderForPayment(one.order.id)?.submission).toBeUndefined();
    expect(api.report).not.toHaveBeenCalled();
    expect(button(/钱包签名并付款/).disabled).toBe(false);
    await click(button(/钱包签名并付款/));
    expect(wallets.sendPayment).toHaveBeenCalledTimes(2);
    expect(api.report).toHaveBeenCalledWith(one.order.id, one.saved.accessToken, txHash);
    expect(buttons(/钱包签名并付款/).every(item => item.disabled)).toBe(true);
    expect(savedOrderForPayment(one.order.id)?.submission?.txHash).toBe(txHash);
  });
  it('passes the exact order quote to approval and requires a separate payment action afterwards', async () => {
    const one = saveOrder(); await render(); await connect(); await confirmRecipient();
    await click(button(/授权本笔额度/));
    expect(wallets.approveExact).toHaveBeenCalledWith(one.order.quote, route, expect.any(Function));
    expect(pageHeading()).toBe('存入 Hyperliquid');
    expect(host.textContent).toContain('代币额度已就绪，尚未付款');
    expect(button(/钱包签名并付款/).disabled).toBe(false);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
    expect(api.report).not.toHaveBeenCalled();
  });
  it('prevents duplicate clicks and order navigation while a wallet operation is pending', async () => {
    const one = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(one.order.quote.amountBaseUnits));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(wallets.sendPayment).mockImplementation(async (_quote, _route, onHash) => { await gate; onHash(txHash); return txHash; });
    await render(); await connect(); await confirmRecipient();
    const pay = button(/钱包签名并付款/);
    await act(async () => { pay.click(); pay.click(); }); await flush();
    expect(wallets.sendPayment).toHaveBeenCalledTimes(1);
    expect(button(/^订单记录$/).disabled).toBe(true);
    await act(async () => { release(); await gate; }); await flush();
    expect(api.report).toHaveBeenCalledTimes(1);
    expect(savedOrderForPayment(one.order.id)?.submission?.txHash).toBe(txHash);
  });
  it('restores the selected history order without mixing a fresh draft with the old quote or clearing unknown state', async () => {
    const paid = saveOrder({ quote: fixtureQuote({ amount: '31.123456', recipient: `0x${'22'.repeat(20)}` }), status: 'source_pending', sourceTxHash: txHash });
    const awaiting = saveOrder({ quote: fixtureQuote({ amount: '41.654321' }) });
    await render(); expect(field('支付金额').value).toBe('41.654321');
    await click(button(/^订单记录$/));
    const historyEntry = [...host.querySelectorAll<HTMLButtonElement>('.history-panel .saved-order')].find(item => item.textContent?.includes(paid.order.id));
    expect(historyEntry).toBeTruthy(); await click(historyEntry!);
    expect(host.textContent).toContain('31.123456');
    expect(host.textContent).toContain(paid.order.quote.recipient);
    expect(host.textContent).not.toContain('41.654321');
    expect(loadSavedOrders().some(item => item.id === awaiting.order.id)).toBe(true);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('blocks payment from an expired restored quote', async () => {
    saveOrder({ quote: { ...fixtureQuote(), expiresAt: '2000-01-01T00:00:00.000Z' } });
    vi.mocked(wallets.getAllowance).mockResolvedValue(10n ** 12n);
    await render(); await connect(); await confirmRecipient();
    expect(buttons(/钱包签名并付款|授权本笔额度/).every(item => item.disabled)).toBe(true);
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
});
