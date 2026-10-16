// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, parseUnits } from 'viem';
import QRCode from 'qrcode';
import App from '../client/App.js';
import { api, readLocalPaymentState, persistSavedOrder, type SavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import type { AppConfig, Order, Quote, QuoteRequest, Route } from '../shared/types.js';

// Execute the real App, dialog, quote validation and local-payment guards. Only
// external wallet/RPC and QR rasterization boundaries are isolated here.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, connectTron: vi.fn(), connectEvm: vi.fn(), disconnectEvm: vi.fn(), getEvmChain: vi.fn(),
    switchEvmChain: vi.fn(), sourceBalance: vi.fn(), sourceNativeBalance: vi.fn(), preflightPayment: vi.fn(),
    listEvmWallets: vi.fn(), getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), evmProvider: vi.fn() };
});
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() } }));

const source = '0x1111111111111111111111111111111111111111';
const different = '0x2222222222222222222222222222222222222222';
const projectId = '1234567890abcdef1234567890abcdef';
const pairingUri = `wc:${'ab'.repeat(32)}@2?relay-protocol=irn&symKey=${'cd'.repeat(32)}`;
const qrImage = 'data:image/png;base64,VEVTVF9PTkxZX1FS';
const ethereum: Route = { id: 'ethereum-usdt-hypercore', label: 'Ethereum USDT → Hyperliquid Perps USDC', sourceChain: 'Ethereum',
  sourceChainId: 1, sourceToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6, walletType: 'evm', available: true, gasSymbol: 'ETH' };
const tron: Route = { id: 'tron-usdt-hypercore', label: 'Tron USDT → Hyperliquid Perps USDC', sourceChain: 'Tron',
  sourceChainId: 728126428, sourceToken: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6, walletType: 'tron', available: true, gasSymbol: 'TRX' };
const baseConfig: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [ethereum, tron], limits: { minAmount: '10', maxAmount: '100' }, paused: false,
  walletConnect: { projectId } };
type ConnectOptions = { projectId: string; chainId: number; onUri: (uri: string) => void; signal?: AbortSignal };
let host: HTMLDivElement;
let root: Root;
let chain: number;
let connected: boolean;
let sequence: number;
let orders: Map<string, Order>;
let listeners: Map<string, Set<(...args: unknown[]) => void>>;
let provider: wallets.BrowserProvider;

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
  const amount = input.amount ?? '10'; const payer = input.sourceAddress ?? source;
  const units = parseUnits(amount, selected.decimals); const protocolOrderId = `0x${'ab'.repeat(32)}` as const;
  const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
  return { id: `TEST_ONLY_WC_QUOTE_${++sequence}`, routeId: selected.id, sourceAddress: payer, recipient: input.recipient ?? source,
    amount, amountBaseUnits: units.toString(), expectedReceive: '9.71234567', minReceive: '9.61234567',
    expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay', fees: [], warnings: [],
    transaction: { kind: 'evm', chainId: 1, to: depository, value: '0', data: encodeFunctionData({
      abi: parseAbi(['function depositErc20(address payer,address token,uint256 amount,bytes32 id)']), functionName: 'depositErc20',
      args: [payer as `0x${string}`, ethereum.sourceToken as `0x${string}`, units, protocolOrderId],
    }) }, approval: { token: selected.sourceToken, spender: depository, amount: units.toString() }, protocolOrderId } as Quote;
}
function saveOrder(quote = fixtureQuote(), changes: Partial<Order> = {}, submission?: SavedOrder['submission']) {
  const createdAt = new Date().toISOString();
  const order: Order = { id: `TEST_ONLY_WC_ORDER_${++sequence}`, createdAt, updatedAt: createdAt, quote,
    status: 'awaiting_signature', statusMessage: '等待签名', events: [], ...changes };
  const saved: SavedOrder = { id: order.id, createdAt, accessToken: `TEST_ONLY_WC_TOKEN_${order.id}`, ...(submission ? { submission } : {}) };
  orders.set(order.id, order); persistSavedOrder(saved); return { order, saved };
}
function buttons(pattern: RegExp, scope: ParentNode = host) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')].filter(node => pattern.test(node.getAttribute('aria-label') ?? node.textContent?.trim() ?? ''));
}
function button(pattern: RegExp, scope: ParentNode = host) { const nodes = buttons(pattern, scope); expect(nodes, `button ${pattern}`).toHaveLength(1); return nodes[0]!; }
function field(id: string) { return host.querySelector<HTMLInputElement>(`#${id}`)!; }
function confirmations() { return [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]; }
function modal() { return host.querySelector<HTMLElement>('dialog[open], [role="dialog"]'); }
function sourceConnect() { return host.querySelector<HTMLButtonElement>('.wallet-row button')!; }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function render() { await act(async () => { root.render(<App />); }); await flush(); }
async function click(node: HTMLElement) { await act(async () => { node.click(); }); await flush(); }
async function input(id: string, value: string) {
  await act(async () => { const node = field(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
}
async function select(id: string, value: string) { await act(async () => { const node = host.querySelector<HTMLSelectElement>(`#${id}`)!;
  node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); }
async function chooseWalletConnect() { await select('evm-wallet', 'walletconnect'); }
async function confirmAll() { for (const checkbox of confirmations()) if (!checkbox.checked) await click(checkbox); }
async function emit(name: string, value: unknown) { await act(async () => { for (const listener of [...listeners.get(name) ?? []]) listener(value); }); await flush(); }
async function ready() { await render(); await chooseWalletConnect(); await click(sourceConnect()); await input('amount', '10'); await confirmAll(); }
function noMoneyCalls() { expect(api.createOrder).not.toHaveBeenCalled(); expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled(); }
function deferredConnection() {
  let options!: ConnectOptions;
  let resolve!: (address: string) => void;
  let reject!: (error: Error) => void;
  vi.mocked(wallets.connectEvm).mockImplementationOnce(async (_id, supplied) => {
    options = supplied as ConnectOptions;
    const address = await new Promise<string>((accept, fail) => {
      resolve = accept; reject = fail;
      options.signal?.addEventListener('abort', () => fail(new Error('连接已取消。')), { once: true });
    }); connected = true; return address;
  });
  return { options: () => options, resolve: async () => { await act(async () => { resolve(source); }); await flush(); },
    reject: async () => { await act(async () => { reject(new Error('用户拒绝了连接请求。')); }); await flush(); } };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('localStorage', new IsolatedStorage());
  Reflect.deleteProperty(window, 'ethereum');
  chain = 1; connected = false; sequence = 0; orders = new Map(); listeners = new Map();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => {
    if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name, mode: 'exclusive' } as Lock); } finally { held.delete(name); }
  } } });
  provider = { request: vi.fn(), on: (name, listener) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); },
    removeListener: (name, listener) => { listeners.get(name)?.delete(listener); } };
  vi.mocked(wallets.listEvmWallets).mockReturnValue([]);
  vi.mocked(wallets.evmProvider).mockImplementation(() => { if (!connected) throw new Error('没有注入或已连接的钱包'); return provider; });
  vi.mocked(wallets.connectEvm).mockImplementation(async () => { connected = true; return source; });
  vi.mocked(wallets.disconnectEvm).mockImplementation(async () => { connected = false; });
  vi.mocked(wallets.connectTron).mockResolvedValue('TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7');
  vi.mocked(wallets.getEvmChain).mockImplementation(async () => chain);
  vi.mocked(wallets.switchEvmChain).mockImplementation(async value => { chain = value; });
  vi.mocked(wallets.sourceBalance).mockResolvedValue('40'); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('1');
  vi.mocked(wallets.getAllowance).mockResolvedValue(0n); vi.mocked(wallets.preflightPayment).mockResolvedValue();
  vi.mocked(wallets.approveExact).mockResolvedValue(); vi.mocked(wallets.sendPayment).mockRejectedValue(new Error('No real signing in isolated UI tests'));
  vi.mocked(QRCode.toDataURL as (uri: string) => Promise<string>).mockResolvedValue(qrImage);
  vi.spyOn(api, 'config').mockResolvedValue(structuredClone(baseConfig));
  vi.spyOn(api, 'quote').mockImplementation(async value => fixtureQuote(value));
  vi.spyOn(api, 'account').mockResolvedValue({ address: source, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() });
  vi.spyOn(api, 'createOrder').mockImplementation(async quoteId => {
    const quote = await vi.mocked(api.quote).mock.results.at(-1)!.value as Quote; expect(quote.id).toBe(quoteId);
    const result = saveOrder(quote); return { order: result.order, accessToken: result.saved.accessToken };
  });
  vi.spyOn(api, 'order').mockImplementation(async id => { const order = orders.get(id); if (!order) throw new Error('No isolated order'); return structuredClone(order); });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('WalletConnect UI without an injected wallet', () => {
  it('keeps an unconfigured scan option visible and passive, with an administrator setup message and no pairing', async () => {
    const config = structuredClone(baseConfig); delete config.walletConnect; vi.mocked(api.config).mockResolvedValue(config);
    await render(); const option = host.querySelector<HTMLOptionElement>('#evm-wallet option[value="walletconnect"]');
    expect(option?.textContent).toMatch(/WalletConnect.*扫码/); expect(option?.disabled).toBe(false);
    await chooseWalletConnect(); expect(sourceConnect().disabled).toBe(true); expect(host.textContent).toMatch(/管理员|Project ID|尚未配置/);
    await click(sourceConnect()); expect(wallets.connectEvm).not.toHaveBeenCalled(); expect(modal()).toBeNull();
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('selecting configured WalletConnect alone does not initialize pairing, connect or consent', async () => {
    await render(); await chooseWalletConnect();
    expect(sourceConnect().disabled).toBe(false); expect(wallets.connectEvm).not.toHaveBeenCalled(); expect(modal()).toBeNull();
    expect(QRCode.toDataURL).not.toHaveBeenCalled(); expect(confirmations()[0]!.checked).toBe(false);
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('keeps an injected wallet usable when WalletConnect has no Project ID', async () => {
    const config = structuredClone(baseConfig); delete config.walletConnect; vi.mocked(api.config).mockResolvedValue(config);
    vi.mocked(wallets.listEvmWallets).mockReturnValue([{ id: 'TEST_ONLY_METAMASK', name: 'MetaMask' }]);
    await render(); await chooseWalletConnect(); expect(sourceConnect().disabled).toBe(true);
    await select('evm-wallet', 'TEST_ONLY_METAMASK'); expect(sourceConnect().disabled).toBe(false);
    await click(sourceConnect()); expect(wallets.connectEvm).toHaveBeenCalledWith('TEST_ONLY_METAMASK');
    expect(modal()).toBeNull(); expect(field('recipient').value).toBe(source); expect(confirmations()[0]!.checked).toBe(false);
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('opens preparation immediately, renders the delivered URI, and connects without quoting, ordering or signing', async () => {
    const pending = deferredConnection(); await render(); await chooseWalletConnect(); await click(sourceConnect());
    expect(modal()?.textContent).toContain('WalletConnect'); expect(modal()?.textContent).toMatch(/准备|生成|连接/);
    expect(wallets.connectEvm).toHaveBeenCalledWith('walletconnect', expect.objectContaining({ projectId, chainId: 1, onUri: expect.any(Function), signal: expect.any(AbortSignal) }));
    await act(async () => { pending.options().onUri(pairingUri); }); await flush();
    expect(QRCode.toDataURL).toHaveBeenCalledWith(pairingUri, expect.any(Object));
    expect(modal()?.querySelector('img')?.getAttribute('src')).toBe(qrImage);
    await pending.resolve(); expect(modal()).toBeNull(); expect(field('recipient').value).toBe(source);
    expect(confirmations()[0]!.checked).toBe(false); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('closes a rejected connection and allows a deliberate retry without automatic money actions', async () => {
    const pending = deferredConnection(); await render(); await chooseWalletConnect(); await click(sourceConnect()); await pending.reject();
    expect(modal()).toBeNull(); expect(sourceConnect().disabled).toBe(false); expect(host.textContent).toMatch(/拒绝/);
    await click(sourceConnect()); expect(wallets.connectEvm).toHaveBeenCalledTimes(2); expect(field('recipient').value).toBe(source);
    expect(confirmations()[0]!.checked).toBe(false); expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('ignores a late URI callback after the connection attempt has already failed', async () => {
    const pending = deferredConnection(); await render(); await chooseWalletConnect(); await click(sourceConnect()); await pending.reject();
    expect(modal()).toBeNull();
    await act(async () => { pending.options().onUri(pairingUri); }); await flush();
    expect(modal()).toBeNull(); expect(QRCode.toDataURL).not.toHaveBeenCalled(); expect(sourceConnect().disabled).toBe(false);
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('cancels pairing with AbortSignal and does not reopen for a late URI, then permits retry', async () => {
    const pending = deferredConnection(); await render(); await chooseWalletConnect(); await click(sourceConnect());
    await click(button(/^取消扫码连接$/, modal()!)); expect(pending.options().signal?.aborted).toBe(true); expect(modal()).toBeNull();
    await act(async () => { pending.options().onUri(pairingUri); }); await flush();
    expect(modal()).toBeNull(); expect(sourceConnect().disabled).toBe(false); expect(QRCode.toDataURL).not.toHaveBeenCalled();
    await click(sourceConnect()); expect(wallets.connectEvm).toHaveBeenCalledTimes(2); expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
  it('ignores old provider callbacks during a pending replacement connection', async () => {
    await ready(); await click(button(/获取实时入金报价/));
    const oldAccounts = [...listeners.get('accountsChanged') ?? []];
    const oldNetwork = [...listeners.get('chainChanged') ?? []];
    expect(oldAccounts.length).toBeGreaterThan(0);
    const pending = deferredConnection(); await click(sourceConnect());
    await act(async () => { for (const listener of oldAccounts) listener([different]); for (const listener of oldNetwork) listener('0x89'); }); await flush();
    expect(host.querySelector('.wallet-row .full-address')).toBeNull(); expect(buttons(/确认报价，创建订单/)).toHaveLength(0);
    expect(field('recipient').value).toBe(source); expect(confirmations()[0]!.checked).toBe(false);
    await pending.resolve(); expect(host.querySelector('.wallet-row .full-address')?.textContent).toBe(source);
    expect(confirmations()[0]!.checked).toBe(false); expect(api.quote).toHaveBeenCalledTimes(1); noMoneyCalls();
  });
  it('aborts a pending pairing when the app unmounts', async () => {
    const pending = deferredConnection(); await render(); await chooseWalletConnect(); await click(sourceConnect());
    await act(async () => root.unmount()); expect(pending.options().signal?.aborted).toBe(true);
    expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
    root = createRoot(host);
  });
  it('disconnects an active quote while preserving entered amount and recipient and requiring fresh consent', async () => {
    await ready(); await click(button(/获取实时入金报价/)); expect(button(/确认报价，创建订单/).disabled).toBe(false);
    await click(button(/断开/)); expect(wallets.disconnectEvm).toHaveBeenCalledTimes(1);
    expect(field('amount').value).toBe('10'); expect(field('recipient').value).toBe(source); expect(confirmations()[0]!.checked).toBe(false);
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(api.quote).toHaveBeenCalledTimes(1); noMoneyCalls();
  });
  it('disconnecting an unpaid created order preserves the order and recovery credential', async () => {
    await ready(); await click(button(/获取实时入金报价/)); await click(button(/确认报价，创建订单/));
    const before = readLocalPaymentState(); expect(before.orders).toHaveLength(1);
    await click(button(/断开/)); expect(readLocalPaymentState()).toEqual(before);
    expect(field('amount').value).toBe('10'); expect(field('recipient').value).toBe(source); expect(confirmations()[0]!.checked).toBe(false);
    expect(host.textContent).toContain('已创建订单'); expect(buttons(/获取实时入金报价/)).toHaveLength(0);
    expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it.each(['accountsChanged', 'chainChanged'] as const)('invalidates a connected quote and consent on %s', async event => {
    await ready(); await click(button(/获取实时入金报价/));
    if (event === 'chainChanged') chain = 137;
    await emit(event, event === 'accountsChanged' ? [different] : '0x89');
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(confirmations().every(item => !item.checked)).toBe(true);
    expect(button(/获取实时入金报价/).disabled).toBe(true); expect(field('recipient').value).toBe(source);
    expect(api.quote).toHaveBeenCalledTimes(1); noMoneyCalls();
  });
  it('keeps Tron on TronLink without offering WalletConnect for the source wallet', async () => {
    await render(); await select('source-network', 'tron:728126428');
    expect(host.querySelector('#evm-wallet')).toBeNull(); expect(host.querySelector('.source-card')?.textContent).toContain('TronLink');
    await click(sourceConnect()); expect(wallets.connectTron).toHaveBeenCalledTimes(1); expect(wallets.connectEvm).not.toHaveBeenCalled();
    expect(modal()).toBeNull(); expect(api.quote).not.toHaveBeenCalled(); noMoneyCalls();
  });
});
