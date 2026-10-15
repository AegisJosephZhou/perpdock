// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../client/App.js';
import { api, persistSavedOrder } from '../client/api.js';
import * as wallets from '../client/wallets.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { AppConfig, Order, Quote } from '../shared/types.js';

// The actual App, readiness component and capability inspector run together.
// Injected providers and remote APIs are isolated fixtures, never real-wallet or
// zero-ETH funding acceptance evidence. All HTTP and transaction paths are spies.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, connectEvm: vi.fn(), connectTron: vi.fn(), getEvmChain: vi.fn(), switchEvmChain: vi.fn(),
    sourceBalance: vi.fn(), sourceNativeBalance: vi.fn(), preflightPayment: vi.fn(), listEvmWallets: vi.fn(),
    getAllowance: vi.fn(), approveExact: vi.fn(), sendPayment: vi.fn(), evmProvider: vi.fn() };
});
const source = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const ethereum = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'ethereum-usdt-hypercore')!.route;
const base = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'base-usdc-hypercore')!.route;
const config: AppConfig = { appName: 'Perpex', network: 'mainnet', routes: [ethereum, base], limits: { minAmount: '10', maxAmount: '100' }, paused: false };
const positive = { '0x1': { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
class IsolatedStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function providerFixture() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let accounts = [source]; let chain = '0x1'; let answer: () => unknown = () => positive;
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_getCapabilities') return answer();
    throw new Error(`Unexpected wallet operation: ${method}`);
  });
  const provider = {
    request,
    on(name: string, callback: (...args: unknown[]) => void) { const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks); },
    removeListener(name: string, callback: (...args: unknown[]) => void) { listeners.get(name)?.delete(callback); },
  } as unknown as wallets.BrowserProvider;
  return { provider, request, account: () => accounts[0]!, chain: () => Number.parseInt(chain, 16), setAnswer(value: () => unknown) { answer = value; },
    emit(name: string, value?: unknown) {
      if (name === 'accountsChanged') accounts = value as string[];
      if (name === 'chainChanged') chain = value as string;
      if (name === 'disconnect') accounts = [];
      for (const callback of [...listeners.get(name) ?? []]) callback(value);
    } };
}
let host: HTMLDivElement; let root: Root; let selected: ReturnType<typeof providerFixture>; let second: ReturnType<typeof providerFixture>;
let store: IsolatedStorage; let storeWrite: ReturnType<typeof vi.spyOn>; let external: ReturnType<typeof vi.fn>;
function button(pattern: RegExp) { const nodes = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(node => pattern.test(node.textContent?.trim() ?? '')); expect(nodes, `button ${pattern}`).toHaveLength(1); return nodes[0]!; }
function readiness() { return host.querySelector('.gasless-readiness'); }
function status() { return readiness()?.querySelector('[role="status"]')?.textContent ?? ''; }
async function flush() { await act(async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); }); }
async function render() { await act(async () => root.render(<App />)); await flush(); }
async function click(node: HTMLElement) { await act(async () => node.click()); await flush(); }
async function connect() { await click(button(/^连接钱包$/)); }
async function inspect() { await click(button(/^检查当前钱包能力$/)); }
async function emit(name: string, value?: unknown) { await act(async () => selected.emit(name, value)); await flush(); }
async function select(id: string, value: string) { await act(async () => { const node = host.querySelector<HTMLSelectElement>(`#${id}`)!; node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); await flush(); }
async function input(id: string, value: string) { await act(async () => { const node = host.querySelector<HTMLInputElement>(`#${id}`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); await flush(); }
async function confirmAll() { for (const node of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) if (!node.checked) await click(node); }
function saveUnsignedOrder() {
  const quote: Quote = { id: 'TEST_ONLY_CAPABILITY_QUOTE', routeId: ethereum.id, sourceAddress: source, recipient: source,
    amount: '10', amountBaseUnits: '10000000', expectedReceive: '9.8', minReceive: '9.7', expiresAt: new Date(Date.now() + 120_000).toISOString(),
    provider: 'Relay', warnings: [], fees: [], approval: { token: ethereum.sourceToken, spender: '0x4cd00e387622c35bddb9b4c962c136462338bc31', amount: '10000000' },
    transaction: { kind: 'evm', chainId: 1, to: '0x4cd00e387622c35bddb9b4c962c136462338bc31', data: '0x', value: '0' } };
  const order: Order = { id: 'TEST_ONLY_CAPABILITY_ORDER', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    quote, status: 'awaiting_signature', statusMessage: '等待签名', events: [] };
  persistSavedOrder({ id: order.id, accessToken: 'TEST_ONLY_CAPABILITY_ACCESS_TOKEN', createdAt: order.createdAt });
  vi.mocked(api.order).mockResolvedValue(order); storeWrite.mockClear();
}
function expectReadOnly() {
  for (const fixture of [selected, second]) expect(fixture.request.mock.calls.every(([arg]) => ['eth_accounts', 'eth_chainId', 'wallet_getCapabilities'].includes(arg.method))).toBe(true);
  expect(wallets.approveExact).not.toHaveBeenCalled(); expect(wallets.sendPayment).not.toHaveBeenCalled(); expect(wallets.preflightPayment).not.toHaveBeenCalled();
  expect(api.quote).not.toHaveBeenCalled(); expect(api.createOrder).not.toHaveBeenCalled(); expect(api.report).not.toHaveBeenCalled(); expect(api.refresh).not.toHaveBeenCalled();
  expect(external).not.toHaveBeenCalled(); expect(storeWrite).not.toHaveBeenCalled();
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  store = new IsolatedStorage(); vi.stubGlobal('localStorage', store); storeWrite = vi.spyOn(store, 'setItem');
  external = vi.fn(() => { throw new Error('No real network in fixture tests'); }); vi.stubGlobal('fetch', external);
  selected = providerFixture(); second = providerFixture(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: LockOptions, callback: (lock: Lock | null) => unknown) => callback({ name: 'TEST_ONLY_LOCK', mode: 'exclusive' } as Lock) } });
  vi.mocked(wallets.evmProvider).mockImplementation(() => selected.provider);
  vi.mocked(wallets.listEvmWallets).mockReturnValue([{ id: 'wallet-1', name: 'TEST_ONLY_FIRST_WALLET' }, { id: 'wallet-2', name: 'TEST_ONLY_SECOND_WALLET' }]);
  vi.mocked(wallets.connectEvm).mockImplementation(async id => { if (id === 'wallet-2') selected = second; return selected.account(); });
  vi.mocked(wallets.getEvmChain).mockImplementation(async () => selected.chain());
  vi.mocked(wallets.sourceBalance).mockResolvedValue('100'); vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('1');
  vi.mocked(wallets.getAllowance).mockResolvedValue(0n);
  vi.spyOn(api, 'config').mockResolvedValue(config);
  vi.spyOn(api, 'account').mockResolvedValue({ address: source, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() });
  vi.spyOn(api, 'order').mockRejectedValue(new Error('No isolated order'));
  for (const name of ['quote', 'createOrder', 'report', 'refresh'] as const) vi.spyOn(api, name).mockRejectedValue(new Error('Unexpected mutation in capability diagnostics'));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(navigator, 'locks'); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('on-demand gasless readiness in the real App', () => {
  it('is absent before connection and never inspects on mount or through polling', async () => {
    await render(); expect(readiness()).toBeNull(); await connect(); expect(readiness()).not.toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(4_000)); await flush();
    expect(selected.request).not.toHaveBeenCalled(); expectReadOnly();
  });
  it('shows positive capability reports while preserving explicit sponsorship limits and read-only behavior', async () => {
    await render(); await connect(); await inspect();
    expect(status()).toContain('批量执行能力：支持；代付接口：支持');
    expect(readiness()?.textContent).toContain('当前版本尚未启用手续费代付'); expect(status()).toContain('尚不能用于本应用免手续费币入金');
    expect(wallets.connectEvm).toHaveBeenCalledTimes(1); expectReadOnly();
  });
  it('explains ready separately from supported without initiating account upgrade', async () => {
    selected.setAnswer(() => ({ '0x1': { atomic: { status: 'ready' }, paymasterService: { supported: true } } }));
    await render(); await connect(); await inspect();
    expect(status()).toContain('需要在钱包中确认升级，尚未就绪'); expectReadOnly();
  });
  it('distinguishes absent capabilities, explicit unsupported capabilities, and unsupported query methods', async () => {
    selected.setAnswer(() => ({})); await render(); await connect(); await inspect();
    expect(status()).toContain('批量执行能力：未能确认；代付接口：未能确认');
    selected.setAnswer(() => ({ '0x1': { atomic: { status: 'unsupported' }, paymasterService: { supported: false } } })); await inspect();
    expect(status()).toContain('批量执行能力：不支持；代付接口：不支持');
    selected.setAnswer(() => { throw { code: 4200, message: 'TEST_ONLY_SECRET_OR_HTML' }; }); await inspect();
    expect(status()).toContain('未提供标准能力查询，暂无法确认代付支持'); expect(status()).not.toContain('TEST_ONLY_SECRET_OR_HTML'); expectReadOnly();
  });
  it('clears the previous positive report on retry, bounds stalled queries, and ignores a late result', async () => {
    await render(); await connect(); await inspect(); const pending = deferred<unknown>(); selected.setAnswer(() => pending.promise); await inspect();
    expect(status()).toBe(''); expect(button(/正在检查钱包能力/).disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(8_001)); await flush();
    expect(status()).toContain('本次未能完成检查'); expect(button(/^检查当前钱包能力$/).disabled).toBe(false);
    await act(async () => pending.resolve(positive)); await flush(); expect(status()).not.toContain('代付接口：支持');
    selected.setAnswer(() => positive); await inspect(); expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it.each(['accountsChanged', 'chainChanged'])('clears a completed report after %s switches away and back in one event batch', async event => {
    await render(); await connect(); await inspect();
    await act(async () => { selected.emit(event, event === 'accountsChanged' ? [other] : '0x89'); selected.emit(event, event === 'accountsChanged' ? [source] : '0x1'); }); await flush();
    expect(status()).toBe(''); expect(button(/^检查当前钱包能力$/).disabled).toBe(false);
    await inspect(); expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it.each(['accountsChanged', 'chainChanged'])('invalidates pending work across %s round trips and never revives its late success', async event => {
    const pending = deferred<unknown>(); selected.setAnswer(() => pending.promise);
    await render(); await connect(); await inspect();
    await act(async () => { selected.emit(event, event === 'accountsChanged' ? [other] : '0x89'); selected.emit(event, event === 'accountsChanged' ? [source] : '0x1'); }); await flush();
    await act(async () => pending.resolve(positive)); await flush(); expect(status()).toBe(''); expect(button(/^检查当前钱包能力$/).disabled).toBe(false);
    selected.setAnswer(() => positive); await inspect(); expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it('removes the report on disconnect and requires an explicit inspection after reconnect', async () => {
    await render(); await connect(); await inspect(); await emit('disconnect'); expect(readiness()).toBeNull();
    await emit('accountsChanged', [source]); expect(status()).toBe(''); await inspect(); expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it('cancels pending work when choosing another wallet and binds the next check to that provider', async () => {
    const original = selected; const pending = deferred<unknown>(); original.setAnswer(() => pending.promise);
    await render(); await connect(); await inspect(); await select('evm-wallet', 'wallet-2'); expect(readiness()).toBeNull();
    await connect(); expect(selected).toBe(second); expect(status()).toBe('');
    await act(async () => pending.resolve(positive)); await flush(); expect(status()).toBe('');
    await inspect(); expect(second.request.mock.calls.filter(([arg]) => arg.method === 'wallet_getCapabilities')).toHaveLength(1);
    expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it('clears a report on route changes and requires the route network before checking again', async () => {
    await render(); await connect(); await inspect(); await select('source-network', 'evm:8453'); expect(readiness()).toBeNull();
    await emit('chainChanged', '0x2105'); expect(status()).toBe(''); selected.setAnswer(() => ({ '0x2105': positive['0x1'] })); await inspect();
    expect(selected.request.mock.calls.filter(([arg]) => arg.method === 'wallet_getCapabilities').at(-1)?.[0]).toEqual({ method: 'wallet_getCapabilities', params: [source, ['0x2105']] });
    expect(status()).toContain('代付接口：支持'); expectReadOnly();
  });
  it('preserves the zero-ETH warning and does not initiate a quote after a positive diagnostic', async () => {
    vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0'); await render(); await connect(); await input('amount', '10'); await confirmAll(); await inspect();
    expect(status()).toContain('代付接口：支持'); expect(host.textContent).toContain('当前没有 ETH 支付链费');
    expect(host.textContent).toContain('暂不能授权或付款'); expectReadOnly();
  });
  it.each([['approval', 0n, /授权本笔额度/], ['payment', 10000000n, /钱包签名并付款/]] as const)('keeps %s disabled for zero ETH despite a positive capability check', async (_stage, allowance, label) => {
    vi.mocked(wallets.sourceNativeBalance).mockResolvedValue('0'); vi.mocked(wallets.getAllowance).mockResolvedValue(allowance); saveUnsignedOrder();
    await render(); await connect(); await confirmAll(); await inspect(); expect(status()).toContain('代付接口：支持');
    expect(button(label).disabled).toBe(true); await click(button(label)); expectReadOnly();
  });
});
