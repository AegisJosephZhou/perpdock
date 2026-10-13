// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, parseAbi, parseUnits } from 'viem';
import App from '../client/App.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import { api, persistSavedOrder, savedOrderForPayment, STORAGE_KEY, SUBMISSION_PREFIX, type SavedOrder } from '../client/api.js';
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
const baseConfig: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [...REVIEWED_EVM_SOURCES.map(item => ({ ...item.route })), tron], limits: { minAmount: '10', maxAmount: '100' }, paused: false };
const finalityWarning = 'TEST_ONLY_FINALITY_WARNING：Ethereum 最终确认和本应用核验可能较晚完成，请勿重复付款。';
let host: HTMLDivElement;
let root: Root;
let mounted: boolean;
let chain: number;
let sequence = 0;
let orders: Map<string, Order>;
let held: Set<string>;
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
  const selected = baseConfig.routes.find(item => item.id === (input.routeId || ethereum.id))!;
  const amount = input.amount ?? '10';
  const source = input.sourceAddress ?? (selected.walletType === 'evm' ? evmSource : tronSource);
  const units = parseUnits(amount, selected.decimals);
  const protocolOrderId = `0x${'ab'.repeat(32)}` as const;
  const quote: Quote & { protocolOrderId?: string } = { id: `TEST_ONLY_ETH_UI_QUOTE_${++sequence}`, routeId: selected.id,
    sourceAddress: source, recipient: input.recipient ?? evmSource, amount, amountBaseUnits: units.toString(),
    expectedReceive: '9.71234567', minReceive: '9.61234567', expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay',
    fees: [{ label: 'TEST_ONLY_SOURCE_FEE', amount: selected.walletType === 'evm' ? '0.00042' : '6', symbol: selected.gasSymbol || 'TRX' }],
    warnings: selected.walletType === 'evm' ? [finalityWarning] : [],
    transaction: selected.walletType === 'evm' ? { kind: 'evm', chainId: selected.sourceChainId, to: depository, value: '0', data: encodeFunctionData({
      abi: parseAbi(['function depositErc20(address payer,address token,uint256 amount,bytes32 id)']), functionName: 'depositErc20',
      args: [source as `0x${string}`, selected.sourceToken as `0x${string}`, units, protocolOrderId],
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
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
async function render() { await act(async () => { root.render(<App />); }); mounted = true; await flush(); }
async function click(node: HTMLElement) { await act(async () => { node.click(); }); await flush(); }
async function input(id: string, value: string) {
  await act(async () => {
    const node = field(id); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }));
  }); await flush();
}
async function choose(id: string) {
  const selected = baseConfig.routes.find(item => item.id === id)!;
  await act(async () => { const network = host.querySelector<HTMLSelectElement>('#source-network')!; network.value = `${selected.walletType}:${selected.sourceChainId}`; network.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
  await act(async () => { select().value = id; select().dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
}
async function emit(name: string, value: unknown) { await act(async () => { for (const callback of [...listeners.get(name) ?? []]) callback(value); }); await flush(); }
async function confirmAll() { for (const checkbox of confirmations()) if (!checkbox.checked) await click(checkbox); }
async function fillEthereum() { await click(button(/^连接钱包$/)); await input('amount', '10'); await confirmAll(); }

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.stubGlobal('localStorage', new IsolatedStorage());
  chain = 1; sequence = 0; orders = new Map(); listeners = new Map(); mounted = false;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  held = new Set<string>();
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
  vi.spyOn(api, 'report').mockImplementation(async (id, _token, hash) => { const latest = { ...orders.get(id)!, sourceTxHash: hash, status: 'source_pending' as const }; orders.set(id, latest); return structuredClone(latest); });
  vi.spyOn(api, 'order').mockImplementation(async id => { const order = orders.get(id); if (!order) throw new Error('No isolated order'); return structuredClone(order); });
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount()); else root.unmount();
  host.remove(); Reflect.deleteProperty(navigator, 'locks'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});

function completed(quote: Quote): Partial<Order> {
  const destinationTxHash = `0x${'cd'.repeat(32)}`;
  return { status: 'completed', sourceTxHash: `0x${'ab'.repeat(32)}`, destinationTxHash, creditedAmount: quote.minReceive,
    evidence: [{ type: 'hypercore_credit', reference: `${quote.recipient}:${destinationTxHash}` }] };
}
async function openSecondHistoryOrder() {
  await click(button(/^订单记录$/));
  await click(host.querySelectorAll<HTMLButtonElement>('.saved-order')[1]!);
}

describe('multi-network user scenarios and browser-wide recovery protection', () => {
  it('groups nine returned routes into networks and exact assets, including USDT0 and native USDC', async () => {
    await render(); expect(host.querySelector<HTMLSelectElement>('#source-network')!.options).toHaveLength(8);
    expect(select().options).toHaveLength(3); expect(select().value).toBe(ethereum.id);
    await choose('arbitrum-usdt-hypercore'); expect(select().value).toBe('arbitrum-usdt-hypercore');
    expect(select().selectedOptions[0]!.textContent).toBe('USDT0'); expect(host.textContent).toContain('Relay 可能仍标为 USDT');
    await choose('arbitrum-usdc-hypercore'); expect(select().selectedOptions[0]!.textContent).toBe('USDC');
    expect(host.querySelector('.asset-identity')?.textContent).toContain('0xaf88d065e77c8cc2239327c5edb3a432268e5831');
    expect(host.querySelector('.asset-identity')?.textContent).toContain('不接受 USDC.e');
  });
  it('invalidates a same-network quote and confirmations when the token changes', async () => {
    await render(); await fillEthereum(); await click(button(/获取实时入金报价/));
    await choose('ethereum-usdc-hypercore'); expect(confirmations()[0]!.checked).toBe(false);
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(host.textContent).not.toContain('9.71234567');
    await confirmAll(); await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenLastCalledWith(expect.objectContaining({ routeId: 'ethereum-usdc-hypercore' }));
  });
  it('preserves BNB token 18-digit precision and uses BNB for fees without changing units', async () => {
    chain = 56; vi.mocked(wallets.sourceBalance).mockResolvedValue('12.345678901234567891');
    await render(); await choose('bsc-usdt-hypercore'); await click(button(/^连接钱包$/));
    expect(host.textContent).toContain('Binance-Peg USDT'); expect(host.textContent).toContain('1 BNB');
    await click(button(/^25%$/)); expect(field('amount').value).toBe('3.086419725308641972');
    await click(button(/^全部$/)); expect(field('amount').value).toBe('12.345678901234567891');
    await confirmAll(); await click(button(/获取实时入金报价/));
    expect(api.quote).toHaveBeenLastCalledWith(expect.objectContaining({ amount: '12.345678901234567891', routeId: 'bsc-usdt-hypercore' }));
    const quoted = await vi.mocked(api.quote).mock.results.at(-1)!.value as Quote;
    expect(quoted.amountBaseUnits).toBe('12345678901234567891');
  });
  it('uses POL rather than ETH for Polygon native-balance and fee messaging', async () => {
    chain = 137; await render(); await choose('polygon-usdc-hypercore'); await click(button(/^连接钱包$/));
    expect(host.querySelector('.native-balance')?.textContent).toContain('1 POL');
    expect(host.querySelector('.source-card')?.textContent).toContain('另需 POL');
  });
  it('selects only a discovered wallet and invalidates the draft when changing wallet choice', async () => {
    vi.mocked(wallets.listEvmWallets).mockReturnValue([{ id: 'metamask-1', name: 'MetaMask' }, { id: 'rabby-1', name: 'Rabby' }]);
    await render();
    await act(async () => { const picker = host.querySelector<HTMLSelectElement>('#evm-wallet')!; picker.value = 'rabby-1'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
    await fillEthereum(); expect(wallets.connectEvm).toHaveBeenCalledWith('rabby-1'); await click(button(/获取实时入金报价/));
    await act(async () => { const picker = host.querySelector<HTMLSelectElement>('#evm-wallet')!; picker.value = 'metamask-1'; picker.dispatchEvent(new Event('change', { bubbles: true })); }); await flush();
    expect(buttons(/确认报价，创建订单/)).toHaveLength(0); expect(confirmations()[0]!.checked).toBe(false);
    await click(button(/^连接钱包$/)); expect(wallets.connectEvm).toHaveBeenLastCalledWith('metamask-1');
  });
  it('uses real EIP-6963 discovery without recursive announcements and connects the announced provider', async () => {
    const actual = await vi.importActual<typeof import('../client/wallets.js')>('../client/wallets.js');
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [evmSource];
      if (method === 'eth_chainId') return '0x1';
      throw new Error(`Unexpected real-discovery RPC: ${method}`);
    });
    const provider = { request } as wallets.BrowserProvider;
    let requests = 0;
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { provider, info: { name: 'TEST_ONLY_ANNOUNCED_WALLET', rdns: 'test.discovery' } } }));
    // The cap lets the assertion report an accidental loop without crashing jsdom.
    const onRequest = () => { requests++; if (requests < 20) announce(); };
    window.addEventListener('eip6963:requestProvider', onRequest);
    vi.mocked(wallets.listEvmWallets).mockImplementation(actual.listEvmWallets);
    vi.mocked(wallets.connectEvm).mockImplementation(actual.connectEvm);
    vi.mocked(wallets.evmProvider).mockImplementation(actual.evmProvider);
    vi.mocked(wallets.getEvmChain).mockImplementation(actual.getEvmChain);
    try {
      await render();
      // Announce again after App's own listener is active, then let discovery poll.
      await act(async () => { announce(); await vi.advanceTimersByTimeAsync(4_000); });
      expect(requests).toBe(1); expect(request).not.toHaveBeenCalled();
      const picker = host.querySelector<HTMLSelectElement>('#evm-wallet')!;
      const option = [...picker.options].find(item => item.textContent === 'TEST_ONLY_ANNOUNCED_WALLET')!;
      expect(option).toBeDefined();
      await act(async () => { picker.value = option.value; picker.dispatchEvent(new Event('change', { bubbles: true })); });
      await click(button(/^连接钱包$/));
      expect(request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' });
      expect(field('recipient').value).toBe(evmSource); expect(requests).toBe(1);
      expect(wallets.sendPayment).not.toHaveBeenCalled();
    } finally { window.removeEventListener('eip6963:requestProvider', onRequest); }
  });
  it('shows true zero gas and blocks authorization without converting read failures into zero', async () => {
    saveOrder(); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0');
    await render(); await click(button(/^连接钱包$/)); await confirmAll();
    expect(host.textContent).toContain('当前没有 ETH 支付链费'); expect(button(/授权本笔额度/).disabled).toBe(true);
    expect(wallets.approveExact).not.toHaveBeenCalled();
    vi.mocked(wallets.sourceNativeBalance).mockRejectedValue(new Error('TEST_ONLY_RPC_OUTAGE'));
    await click(button(/刷新付款钱包余额/)); expect(host.textContent).not.toContain('当前没有 ETH 支付链费');
    expect(host.querySelector('.native-balance')?.textContent).toContain('暂无法读取');
  });
  it('keeps known preflight failure outside signing state, so a corrected balance can be retried safely', async () => {
    const entry = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(entry.order.quote.amountBaseUnits));
    vi.mocked(wallets.preflightPayment).mockRejectedValue(new Error('TEST_ONLY_ESTIMATED_GAS_INSUFFICIENT'));
    await render(); await click(button(/^连接钱包$/)); await confirmAll(); await click(button(/钱包签名并付款/));
    expect(wallets.preflightPayment).toHaveBeenCalledTimes(1); expect(wallets.sendPayment).not.toHaveBeenCalled();
    expect(savedOrderForPayment(entry.order.id)?.submission).toBeUndefined(); expect(host.textContent).not.toContain('付款结果待核查');
    expect(button(/钱包签名并付款/).disabled).toBe(false);
  });
  it('performs preflight before any durable signing marker, then retains the broadcast hash', async () => {
    const entry = saveOrder(); const hash = `0x${'ef'.repeat(32)}`;
    vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(entry.order.quote.amountBaseUnits));
    vi.mocked(wallets.preflightPayment).mockImplementation(async () => { expect(savedOrderForPayment(entry.order.id)?.submission).toBeUndefined(); });
    vi.mocked(wallets.sendPayment).mockImplementation(async (_q, _r, onHash) => { expect(savedOrderForPayment(entry.order.id)?.submission?.state).toBe('signing'); onHash(hash); return hash; });
    await render(); await click(button(/^连接钱包$/)); await confirmAll(); await click(button(/钱包签名并付款/));
    expect(savedOrderForPayment(entry.order.id)?.submission?.txHash).toBe(hash); expect(wallets.sendPayment).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown A blocking new actions after history navigation to unpaid B', async () => {
    saveOrder(); const a = saveOrder(fixtureQuote(), {}, { state: 'unknown' });
    await render(); await openSecondHistoryOrder(); await click(button(/^连接钱包$/)); await confirmAll();
    expect(button(/重新填写入金/).disabled).toBe(true); expect(button(/授权本笔额度/).disabled).toBe(true);
    expect(host.querySelector('.pending-payments')?.textContent).toContain('此浏览器存在未结清');
    expect(savedOrderForPayment(a.order.id)?.submission?.state).toBe('unknown'); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('keeps unknown A blocking a new deposit after history navigation to verified completed B', async () => {
    const q = fixtureQuote(); saveOrder(q, completed(q), { state: 'submitted', txHash: `0x${'ab'.repeat(32)}` });
    saveOrder(fixtureQuote(), {}, { state: 'unknown' });
    await render(); await openSecondHistoryOrder(); expect(button(/开始新入金/).disabled).toBe(true);
    await click(button(/开始新入金/)); expect(host.querySelector('main h1')?.textContent).toBe('入金进度'); expect(api.quote).not.toHaveBeenCalled();
  });
  it('unblocks only when the marker order has valid server completion evidence', async () => {
    const q = fixtureQuote(); saveOrder(q, completed(q), { state: 'submitted', txHash: `0x${'ab'.repeat(32)}` });
    saveOrder(); await render(); expect(host.querySelector('.pending-payments')).toBeNull(); expect(button(/重新填写入金/).disabled).toBe(false);
  });
  it('reuses only verified terminal history in page memory while an unknown order is checked afresh', async () => {
    const completedIds = Array.from({ length: 25 }, () => {
      const q = fixtureQuote(); return saveOrder(q, completed(q), { state: 'submitted', txHash: `0x${'ab'.repeat(32)}` }).order.id;
    });
    const unknown = saveOrder(fixtureQuote(), {}, { state: 'unknown' }); saveOrder();
    await render();
    const reads = (id: string) => vi.mocked(api.order).mock.calls.filter(call => call[0] === id).length;
    for (const id of completedIds) expect(reads(id)).toBe(1);
    const before = reads(unknown.order.id);
    await click(button(/重新核查本机订单/)); await click(button(/重新核查本机订单/));
    for (const id of completedIds) expect(reads(id)).toBe(1);
    expect(reads(unknown.order.id)).toBeGreaterThanOrEqual(before + 2);
    expect(button(/重新填写入金/).disabled).toBe(true);
    orders.set(unknown.order.id, { ...unknown.order, ...completed(unknown.order.quote) });
    await click(button(/重新核查本机订单/));
    expect(host.querySelector('.pending-payments')).toBeNull(); expect(button(/重新填写入金/).disabled).toBe(false);
  });
  it('stops polling a verified completed current order and never persists a trusted-completion flag', async () => {
    const q = fixtureQuote(); const entry = saveOrder(q, completed(q), { state: 'submitted', txHash: `0x${'ab'.repeat(32)}` });
    await render(); expect(api.order).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await click(button(/刷新连接与只读核验/)); expect(api.order).toHaveBeenCalledTimes(1);
    expect(savedOrderForPayment(entry.order.id)).toEqual(entry.saved);
  });
  it('keeps a server completed response with missing credit evidence blocked', async () => {
    const q = fixtureQuote(); saveOrder(q, { ...completed(q), evidence: [] }, { state: 'submitted', txHash: `0x${'ab'.repeat(32)}` });
    saveOrder(); await render(); expect(button(/重新填写入金/).disabled).toBe(true); expect(host.querySelector('.pending-payments')).not.toBeNull();
  });
  it('does not unlock when another order cannot be recovered from the server', async () => {
    const a = saveOrder(fixtureQuote(), {}, { state: 'unknown' }); saveOrder();
    vi.mocked(api.order).mockImplementation(async id => { if (id === a.order.id) throw new Error('TEST_ONLY_RECOVERY_OUTAGE'); return structuredClone(orders.get(id)!); });
    await render(); expect(button(/重新填写入金/).disabled).toBe(true); expect(host.textContent).toContain('部分订单暂时无法恢复');
  });
  it.each(['orphan', 'corrupt'] as const)('treats %s local recovery state as a blocker rather than empty history', async kind => {
    if (kind === 'orphan') localStorage.setItem(`${SUBMISSION_PREFIX}TEST_ONLY_ORPHAN`, JSON.stringify({ state: 'unknown' }));
    else localStorage.setItem(STORAGE_KEY, '{invalid-json');
    await render(); await fillEthereum(); expect(button(/获取实时入金报价/).disabled).toBe(true);
    expect(host.querySelector('.pending-payments')).not.toBeNull(); expect(api.quote).not.toHaveBeenCalled();
  });
  it('refreshes browser-wide blockers after another tab saves an unknown payment', async () => {
    const b = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(b.order.quote.amountBaseUnits));
    await render(); await click(button(/^连接钱包$/)); await confirmAll(); expect(button(/钱包签名并付款/).disabled).toBe(false);
    saveOrder(fixtureQuote(), {}, { state: 'unknown' });
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY })); }); await flush();
    expect(button(/钱包签名并付款/).disabled).toBe(true); expect(button(/重新填写入金/).disabled).toBe(true); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('blocks a different-tab intent while the global lock is held, before preflight or marking signing', async () => {
    const entry = saveOrder(); vi.mocked(wallets.getAllowance).mockResolvedValue(BigInt(entry.order.quote.amountBaseUnits));
    await render(); await click(button(/^连接钱包$/)); await confirmAll(); held.add('hl-funding.active-payment.v1');
    await click(button(/钱包签名并付款/)); expect(host.textContent).toContain('另一个标签页正在准备或处理入金');
    expect(wallets.preflightPayment).not.toHaveBeenCalled(); expect(savedOrderForPayment(entry.order.id)?.submission).toBeUndefined();
  });
  it('shows offline state and only refreshes reads when the connection returns', async () => {
    const status = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    await render(); await fillEthereum(); expect(host.textContent).toContain('当前已离线'); expect(button(/获取实时入金报价/).disabled).toBe(true);
    status.mockReturnValue(true); await act(async () => { window.dispatchEvent(new Event('online')); }); await flush();
    expect(host.textContent).not.toContain('当前已离线'); expect(api.quote).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled();
  });
  it('explains missing browser capability and does not fabricate a mobile public link or a QR connection', async () => {
    Reflect.deleteProperty(navigator, 'locks'); await render(); await fillEthereum();
    expect(button(/获取实时入金报价/).disabled).toBe(true); expect(host.textContent).toContain('当前浏览器缺少安全付款能力');
    expect(host.textContent).toContain('交易所提现不能完成本应用的授权与入金调用');
    expect(host.textContent).toContain('当前为本地或非公开 HTTPS 地址'); expect(buttons(/复制当前 HTTPS 网址/)).toHaveLength(0);
    expect(host.querySelector('canvas, img[alt*="二维码"]')).toBeNull();
  });
});
