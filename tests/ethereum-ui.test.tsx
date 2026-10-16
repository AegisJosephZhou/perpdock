// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, parseUnits } from 'viem';
import App from '../client/App.js';
import { api, persistSavedOrder, type SavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import type { AppConfig, Order, Quote, QuoteRequest, Route } from '../shared/types.js';

// Only external wallet/RPC calls are substituted. The real component, quote
// context validation, persisted order selection and UI guards execute.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, connectTron: vi.fn(), connectEvm: vi.fn(), getEvmChain: vi.fn(), switchEvmChain: vi.fn(),
    sourceBalance: vi.fn(), sourceNativeBalance: vi.fn(), preflightPayment: vi.fn(), listEvmWallets: vi.fn(), getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), evmProvider: vi.fn() };
});

const evmSource = '0x1111111111111111111111111111111111111111';
const differentRecipient = '0x2222222222222222222222222222222222222222';
const tronSource = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const ethereum: Route = { id: 'ethereum-usdt-hypercore', label: 'Ethereum 主网 USDT → Hyperliquid Perps USDC', sourceChain: 'Ethereum',
  sourceChainId: 1, sourceToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, walletType: 'evm', available: true };
const tron: Route = { id: 'tron-usdt-hypercore', label: 'Tron USDT → Hyperliquid Perps USDC', sourceChain: 'Tron',
  sourceChainId: 728126428, sourceToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6, walletType: 'tron', available: true };
const baseConfig: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [ethereum, tron], limits: { minAmount: '10', maxAmount: '100' }, paused: false };
const finalityWarning = 'TEST_ONLY_FINALITY_WARNING：Ethereum 最终确认和本应用核验可能较晚完成，请勿重复付款。';
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let chain: number;
let sequence: number;
let orders: Map<string, Order>;
let listeners: Map<string, Set<(...args: unknown[]) => void>>;

class IsolatedStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}
function fixtureQuote(input: Partial<QuoteRequest> = {}): Quote {
  const selected = input.routeId === tron.id ? tron : ethereum;
  const amount = input.amount ?? '10';
  const source = input.sourceAddress ?? (selected.walletType === 'evm' ? evmSource : tronSource);
  const units = parseUnits(amount, 6);
  const protocolOrderId = `0x${'ab'.repeat(32)}` as const;
  const quote: Quote & { protocolOrderId?: string } = { id: `TEST_ONLY_ETH_UI_QUOTE_${++sequence}`, routeId: selected.id,
    sourceAddress: source, recipient: input.recipient ?? evmSource, amount, amountBaseUnits: units.toString(),
    expectedReceive: '9.71234567', minReceive: '9.61234567', expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay',
    fees: [{ label: 'TEST_ONLY_SOURCE_FEE', amount: selected.walletType === 'evm' ? '0.00042' : '6', symbol: selected.walletType === 'evm' ? 'ETH' : 'TRX' }],
    warnings: selected.walletType === 'evm' ? [finalityWarning] : [],
    transaction: selected.walletType === 'evm' ? { kind: 'evm', chainId: 1, to: depository, value: '0', data: encodeFunctionData({
      abi: parseAbi(['function depositErc20(address payer,address token,uint256 amount,bytes32 id)']), functionName: 'depositErc20',
      args: [source as `0x${string}`, ethereum.sourceToken as `0x${string}`, units, protocolOrderId],
    }) } : { kind: 'tron', transaction: {} },
    approval: { token: selected.sourceToken, spender: selected.walletType === 'evm' ? depository : 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN', amount: units.toString() },
    ...(selected.walletType === 'evm' ? { protocolOrderId } : {}),
  };
  return quote;
}
function saveOrder(quote = fixtureQuote(), changes: Partial<Order> = {}, submission?: SavedOrder['submission'], persist = true) {
  const at = new Date().toISOString();
  const order: Order = { id: `TEST_ONLY_ETH_UI_ORDER_${++sequence}`, createdAt: at, updatedAt: at, quote,
    status: 'awaiting_signature', statusMessage: '等待签名', events: [], ...changes };
  const saved: SavedOrder = { id: order.id, accessToken: `TEST_ONLY_TOKEN_${order.id}`, createdAt: at, ...(submission ? { submission } : {}) };
  orders.set(order.id, order); if (persist) persistSavedOrder(saved); return { order, saved };
}
function buttons(pattern: RegExp) { return [...host.querySelectorAll('button')].filter(node => pattern.test(node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '')); }
function button(pattern: RegExp): HTMLButtonElement {
  const nodes = buttons(pattern); expect(nodes, `button ${pattern}`).toHaveLength(1); return nodes[0]!;
}
function field(id: string): HTMLInputElement { return host.querySelector<HTMLInputElement>(`#${id}`)!; }
function select() { return host.querySelector<HTMLSelectElement>('#route')!; }
function confirmations() { return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; }
function actionStatus() { return host.querySelector<HTMLElement>('.action-area [role="status"][aria-label="入金操作提示"]'); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function render() { await act(async () => { root.render(<App />); }); mounted = true; await flush(); }
async function click(node: HTMLElement) { await act(async () => { node.click(); }); await flush(); }
async function input(id: string, value: string) {
  await act(async () => {
    const node = field(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  }); await flush();
}
async function choose(id: string) { await act(async () => { const network = host.querySelector<HTMLSelectElement>('#source-network')!; const selected = id === tron.id ? tron : ethereum; network.value = `${selected.walletType}:${selected.sourceChainId}`; network.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); }
async function emit(name: string, value: unknown) { await act(async () => { for (const callback of [...listeners.get(name) ?? []]) callback(value); }); await flush(); }
async function confirmAll() { for (const checkbox of confirmations()) if (!checkbox.checked) await click(checkbox); }
async function fillEthereum() { await click(button(/^连接钱包$/)); await input('amount', '10'); await confirmAll(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('localStorage', new IsolatedStorage());
  chain = 1; sequence = 0; orders = new Map(); listeners = new Map(); mounted = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => { if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name, mode: 'exclusive' } as Lock); } finally { held.delete(name); } } } });
  vi.mocked(wallets.listEvmWallets).mockReturnValue([]);
  vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('1');
  vi.mocked(wallets.preflightPayment).mockResolvedValue();
  vi.mocked(wallets.evmProvider).mockReturnValue({ request: vi.fn(),
    on: (name: string, callback: (...args: unknown[]) => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
    removeListener: (name: string, callback: (...args: unknown[]) => void) => { listeners.get(name)?.delete(callback); },
  });
  vi.mocked(wallets.connectEvm).mockResolvedValue(evmSource);
  vi.mocked(wallets.connectTron).mockResolvedValue(tronSource);
  vi.mocked(wallets.getEvmChain).mockImplementation(async () => chain);
  vi.mocked(wallets.switchEvmChain).mockImplementation(async id => { chain = id; });
  vi.mocked(wallets.sourceBalance).mockImplementation(async selected => selected.id === ethereum.id ? '40.123456' : '70.654321');
  vi.mocked(wallets.getAllowance).mockResolvedValue(0n);
  vi.mocked(wallets.approveExact).mockResolvedValue();
  vi.mocked(wallets.sendPayment).mockRejectedValue(new Error('No real signing in UI tests'));
  vi.spyOn(api, 'config').mockResolvedValue(structuredClone(baseConfig));
  vi.spyOn(api, 'quote').mockImplementation(async request => fixtureQuote(request));
  vi.spyOn(api, 'account').mockResolvedValue({ address: evmSource, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() });
  vi.spyOn(api, 'createOrder').mockImplementation(async quoteId => {
    const quoted = await vi.mocked(api.quote).mock.results.at(-1)!.value as Quote; expect(quoted.id).toBe(quoteId);
    const entry = saveOrder(quoted, {}, undefined, false); return { order: entry.order, accessToken: entry.saved.accessToken };
  });
  vi.spyOn(api, 'order').mockImplementation(async id => { const order = orders.get(id); if (!order) throw new Error('No isolated order'); return structuredClone(order); });
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount()); else root.unmount();
  host.remove(); Reflect.deleteProperty(navigator, 'locks'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('Ethereum and Tron real-route UI guards', () => {
  it('explains the missing wallet and recipient consent beside the disabled quote action, then clears the hint when ready', async () => {
    await render(); await input('amount', '10'); await input('recipient', evmSource);
    expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(actionStatus()?.textContent).toMatch(/连接.*钱包/);
    expect(button(/获取实时入金报价/).getAttribute('aria-describedby')).toBe(actionStatus()?.id);
    await click(button(/获取实时入金报价/)); expect(api.quote).not.toHaveBeenCalled();
    await click(button(/^连接钱包$/));
    expect(button(/获取实时入金报价/).disabled).toBe(true); expect(confirmations()[0]!.checked).toBe(false);
    expect(actionStatus()?.textContent).toMatch(/(?:核对|确认).*接收地址/);
    await confirmAll();
    expect(button(/获取实时入金报价/).disabled).toBe(false); expect(actionStatus()).toBeNull();
    expect(api.quote).not.toHaveBeenCalled(); expect(api.createOrder).not.toHaveBeenCalled();
    expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('defaults to the first available Ethereum route and fills the connected address without consenting for the user', async () => {
    await render(); expect(select().value).toBe(ethereum.id); expect(host.querySelector<HTMLSelectElement>('#source-network')!.options).toHaveLength(3);
    expect(host.textContent).toContain('MetaMask / Rabby'); expect(host.textContent).toContain('ETH 支付 Ethereum 主网');
    await click(button(/^连接钱包$/)); await input('amount', '10');
    expect(field('recipient').value).toBe(evmSource); expect(confirmations()).toHaveLength(1); expect(confirmations()[0]!.checked).toBe(false);
    expect(button(/获取实时入金报价/).disabled).toBe(true); expect(api.quote).not.toHaveBeenCalled();
    await click(button(/填入已连接地址/)); expect(wallets.connectEvm).toHaveBeenCalledTimes(1); expect(confirmations()[0]!.checked).toBe(false);
    await confirmAll(); await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenCalledWith({ routeId: ethereum.id, amount: '10', sourceAddress: evmSource, recipient: evmSource });
  });
  it('preserves a manually entered different recipient and requires both ownership confirmations', async () => {
    await render(); await input('recipient', differentRecipient); await click(button(/^连接钱包$/)); await input('amount', '10');
    expect(field('recipient').value).toBe(differentRecipient); expect(confirmations()).toHaveLength(2);
    await click(confirmations()[0]!); expect(button(/获取实时入金报价/).disabled).toBe(true);
    await click(confirmations()[1]!); await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenCalledWith(expect.objectContaining({ recipient: differentRecipient }));
  });
  it('blocks balances and quotes on a wrong wallet chain, then requires confirmation after switching to Ethereum', async () => {
    chain = 137; await render(); await fillEthereum();
    expect(wallets.sourceBalance).not.toHaveBeenCalled(); expect(button(/获取实时入金报价/).disabled).toBe(true);
    await click(button(/切换钱包至 Ethereum 主网/)); expect(wallets.switchEvmChain).toHaveBeenCalledWith(1);
    expect(confirmations()[0]!.checked).toBe(false); expect(button(/获取实时入金报价/).disabled).toBe(true);
    await confirmAll(); await click(button(/获取实时入金报价/)); expect(api.quote).toHaveBeenCalledTimes(1);
  });
  it('rechecks the chain before an API quote even when the provider omitted its chainChanged event', async () => {
    await render(); await fillEthereum(); chain = 10;
    await click(button(/获取实时入金报价/)); expect(api.quote).not.toHaveBeenCalled();
    expect(host.textContent).toContain('请先将付款钱包切换至 Ethereum 主网'); expect(confirmations()[0]!.checked).toBe(false);
  });
  it('invalidates a quoted intent and both confirmations when the wallet network changes', async () => {
    await render(); await fillEthereum(); await input('recipient', differentRecipient); await confirmAll(); await click(button(/获取实时入金报价/));
    expect(button(/确认报价，创建订单/).disabled).toBe(false);
    chain = 137; await emit('chainChanged', '0x89');
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(confirmations().every(item => !item.checked)).toBe(true);
    expect(host.textContent).not.toContain('40.123456'); expect(button(/获取实时入金报价/).disabled).toBe(true);
  });
  it('discards the old quote on wallet disconnect and requires reconnecting and fresh consent before another quote', async () => {
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/));
    expect(button(/确认报价，创建订单/).disabled).toBe(false);
    await emit('disconnect', { code: 4900 });
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(host.textContent).not.toContain('9.71234567');
    expect(field('amount').value).toBe('10'); expect(field('recipient').value).toBe(evmSource);
    expect(confirmations()[0]!.checked).toBe(false); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(actionStatus()?.textContent).toMatch(/连接.*钱包/);
    await click(button(/获取实时入金报价/)); expect(api.quote).toHaveBeenCalledTimes(1);
    await click(button(/^连接钱包$/));
    expect(confirmations()[0]!.checked).toBe(false); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(actionStatus()?.textContent).toMatch(/(?:核对|确认).*接收地址/);
    await confirmAll();
    expect(button(/获取实时入金报价/).disabled).toBe(false); expect(actionStatus()).toBeNull();
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(api.quote).toHaveBeenCalledTimes(1);
    expect(api.createOrder).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('allows reading a quote with zero ETH but explains why creating the order remains disabled', async () => {
    vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0');
    await render(); await fillEthereum();
    expect(button(/获取实时入金报价/).disabled).toBe(false); expect(actionStatus()).toBeNull();
    await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenCalledTimes(1); expect(button(/确认报价，创建订单/).disabled).toBe(true);
    expect(actionStatus()?.textContent).toContain('ETH'); expect(actionStatus()?.textContent).toMatch(/手续费|链费/);
    await click(button(/确认报价，创建订单/));
    expect(api.createOrder).not.toHaveBeenCalled(); expect(wallets.approveExact).not.toHaveBeenCalled();
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('rejects a stale in-flight quote after the network changes', async () => {
    let resolve!: (quote: Quote) => void;
    vi.mocked(api.quote).mockImplementationOnce(() => new Promise<Quote>(done => { resolve = done; }));
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/));
    chain = 137; await emit('chainChanged', '0x89');
    await act(async () => { resolve(fixtureQuote()); }); await flush();
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(host.textContent).not.toContain('9.71234567');
  });
  it('rechecks the chain before creating an order from an existing quote', async () => {
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/)); chain = 10;
    await click(button(/确认报价，创建订单/)); expect(api.createOrder).not.toHaveBeenCalled();
    expect(button(/获取实时入金报价/).disabled).toBe(true);
  });
  it('clears Ethereum quote, balance and confirmations when selecting Tron, retaining TronLink and TRX behavior', async () => {
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/));
    await choose(tron.id); expect(select().value).toBe(tron.id); expect(host.textContent).toContain('TronLink'); expect(host.textContent).toContain('另需 TRX');
    expect(host.textContent).not.toContain('40.123456'); expect(host.textContent).not.toContain('9.71234567'); expect(confirmations()[0]!.checked).toBe(false);
    expect(button(/获取实时入金报价/).disabled).toBe(true);
    await click(button(/^连接钱包$/)); expect(host.textContent).toContain('70.654321'); await confirmAll(); await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenLastCalledWith({ routeId: tron.id, amount: '10', sourceAddress: tronSource, recipient: evmSource });
    expect(wallets.connectTron).toHaveBeenCalledTimes(1);
  });
  it('uses the independently available Tron route when Ethereum is unavailable', async () => {
    vi.mocked(api.config).mockResolvedValue({ ...baseConfig, routes: [{ ...ethereum, available: false, reason: 'TEST_ONLY_UNAVAILABLE' }, tron] });
    await render(); expect(select().value).toBe(tron.id); expect(host.querySelector<HTMLSelectElement>('#source-network')!.options[1]!.disabled).toBe(true); expect(host.querySelector<HTMLSelectElement>('#source-network')!.options[2]!.disabled).toBe(false);
    expect(host.textContent).toContain('TronLink');
  });
  it('restores an existing Tron order to Tron even when Ethereum is the new default', async () => {
    saveOrder(fixtureQuote({ routeId: tron.id })); await render();
    expect(select().value).toBe(tron.id); expect(select().disabled).toBe(true); expect(host.textContent).toContain('150 TRX');
    expect(host.textContent).not.toContain('ETH 支付 Ethereum 主网');
    await click(button(/^连接钱包$/)); await confirmAll(); expect(button(/授权本笔额度/).disabled).toBe(false);
    expect(wallets.connectTron).toHaveBeenCalledTimes(1); expect(wallets.connectEvm).not.toHaveBeenCalled();
  });
  it('blocks approval and payment of an existing Ethereum order after a chain switch', async () => {
    const entry = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(entry.order.quote.amountBaseUnits));
    await render(); await click(button(/^连接钱包$/)); await confirmAll(); expect(button(/钱包签名并付款/).disabled).toBe(false);
    chain = 10; await emit('chainChanged', '0xa');
    expect(buttons(/钱包签名并付款|授权本笔额度/).every(item => item.disabled)).toBe(true);
    expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['awaiting_signature', 'expired'] as const)('keeps unknown Ethereum payments in recovery when the order is %s', async status => {
    const quote = fixtureQuote(); if (status === 'expired') quote.expiresAt = '2000-01-01T00:00:00.000Z';
    saveOrder(quote, { status }, { state: 'unknown' }); await render();
    expect(host.querySelector('main h1')?.textContent).toBe('入金进度'); expect(host.querySelector('#route')).toBeNull();
    expect(buttons(/获取实时入金报价|重新获取报价|返回并重新报价|开始新入金|重新填写入金|钱包签名并付款/)).toHaveLength(0);
    expect(host.textContent).toContain(finalityWarning); expect(api.quote).not.toHaveBeenCalled();
    expect(api.createOrder).not.toHaveBeenCalled(); expect(wallets.approveExact).not.toHaveBeenCalled();
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('returns an unpaid expired order to preparation without quoting or signing, preserving fields but resetting consent', async () => {
    const quote = fixtureQuote(); quote.expiresAt = '2000-01-01T00:00:00.000Z';
    saveOrder(quote, { status: 'expired' }); await render(); await click(button(/^连接钱包$/)); await confirmAll();
    expect(button(/返回并重新报价/).disabled).toBe(false);
    expect(host.querySelector('.action-area')?.textContent).toMatch(/(?:核对|确认).*接收地址/);
    await click(button(/返回并重新报价/));
    expect(field('amount').value).toBe('10'); expect(field('recipient').value).toBe(evmSource);
    expect(confirmations()[0]!.checked).toBe(false); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(actionStatus()?.textContent).toMatch(/(?:核对|确认).*接收地址/);
    expect(api.quote).not.toHaveBeenCalled(); expect(api.createOrder).not.toHaveBeenCalled();
    expect(wallets.connectEvm).toHaveBeenCalledTimes(1); expect(wallets.approveExact).not.toHaveBeenCalled();
    expect(wallets.sendPayment).not.toHaveBeenCalled();
    await confirmAll();
    expect(button(/获取实时入金报价/).disabled).toBe(false); expect(actionStatus()).toBeNull();
    expect(api.quote).not.toHaveBeenCalled();
    await click(button(/获取实时入金报价/)); expect(api.quote).toHaveBeenCalledTimes(1);
    expect(button(/确认报价，创建订单/).disabled).toBe(false); expect(api.createOrder).not.toHaveBeenCalled();
    expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('shows Ethereum quote fees and finality warnings without inventing a total arrival estimate', async () => {
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/));
    expect(host.textContent).toContain('0.00042 ETH'); expect(host.textContent).toContain(finalityWarning);
    expect(host.textContent).not.toContain('约 1 秒'); expect(host.textContent).not.toContain('预计处理时间');
    await click(button(/确认报价，创建订单/)); expect(host.textContent).toContain('Ethereum 主网授权与付款分别消耗 ETH');
  });
});
