import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectWalletCapabilities, parseWalletCapabilities } from '../client/wallet-capabilities.js';
import * as wallets from '../client/wallets.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { Route } from '../shared/types.js';

// Isolated provider responses only: these are not evidence about a real wallet,
// deployed chain, a paymaster, sponsorship, or a completed deposit.
vi.mock('../client/wallets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../client/wallets.js')>();
  return { ...actual, evmProvider: vi.fn() };
});
const route = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'ethereum-usdt-hypercore')!.route;
const source = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
const unknown = { atomic: 'unknown', paymaster: 'unknown' };
const positive = { '0x1': { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function providerFixture() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let accounts: unknown = [source]; let chain: unknown = '0x1';
  let answer: () => unknown = () => positive;
  const request = vi.fn(async ({ method }: { method: string; params?: unknown }) => {
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_chainId') return chain;
    if (method === 'wallet_getCapabilities') return answer();
    throw new Error(`Unexpected wallet operation: ${method}`);
  });
  const provider = {
    request,
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => { const callbacks = listeners.get(name) ?? new Set(); callbacks.add(callback); listeners.set(name, callbacks); }),
    removeListener: vi.fn((name: string, callback: (...args: unknown[]) => void) => { listeners.get(name)?.delete(callback); }),
  } as unknown as wallets.BrowserProvider;
  return { provider, request, setAccounts(value: unknown) { accounts = value; }, setChain(value: unknown) { chain = value; },
    setAnswer(value: () => unknown) { answer = value; }, listenerCount: () => [...listeners.values()].reduce((sum, values) => sum + values.size, 0),
    emit(name: string, value?: unknown) { for (const callback of [...listeners.get(name) ?? []]) callback(value); } };
}
async function reachCapabilityRequest(provider: ReturnType<typeof providerFixture>) {
  for (let count = 0; count < 12; count++) { if (provider.request.mock.calls.some(([arg]) => arg.method === 'wallet_getCapabilities')) return; await Promise.resolve(); }
  throw new Error('Capability query did not begin');
}
let selected: ReturnType<typeof providerFixture>;
let network: ReturnType<typeof vi.fn>;
let storage: { setItem: ReturnType<typeof vi.fn>; getItem: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.useFakeTimers(); selected = providerFixture(); vi.mocked(wallets.evmProvider).mockImplementation(() => selected.provider);
  network = vi.fn(() => { throw new Error('Unexpected external HTTP'); }); vi.stubGlobal('fetch', network);
  storage = { setItem: vi.fn(), getItem: vi.fn() }; vi.stubGlobal('localStorage', storage); vi.stubGlobal('sessionStorage', storage);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('untrusted wallet capability parsing', () => {
  it.each(['supported', 'ready', 'unsupported'] as const)('preserves atomic status %s rather than promoting ready', status => {
    expect(parseWalletCapabilities({ '0x1': { atomic: { status }, paymasterService: { supported: true } } }, 1)).toEqual({ atomic: status, paymaster: 'supported' });
  });
  it('uses global capabilities and independently overlays only the same per-chain names', () => {
    expect(parseWalletCapabilities({ '0x0': { atomic: { status: 'supported' }, paymasterService: { supported: true } }, '0x1': { atomic: { status: 'unsupported' } } }, 1)).toEqual({ atomic: 'unsupported', paymaster: 'supported' });
    expect(parseWalletCapabilities({ '0x0': { atomic: { status: 'ready' }, paymasterService: { supported: true } }, '0x1': { paymasterService: { supported: false } } }, 1)).toEqual({ atomic: 'ready', paymaster: 'unsupported' });
  });
  it('does not fall back to positive globals after a malformed per-chain override', () => {
    expect(parseWalletCapabilities({ '0x0': { atomic: { status: 'supported' }, paymasterService: { supported: true } }, '0x1': { atomic: null, paymasterService: { supported: 'true' } } }, 1)).toEqual(unknown);
  });
  it('ignores other-chain capabilities, wallet brands, and legacy atomicBatch values', () => {
    expect(parseWalletCapabilities({ '0x89': positive['0x1'], isMetaMask: true, atomicBatch: { supported: true }, '0x1': { atomicBatch: { supported: true } } }, 1)).toEqual(unknown);
  });
  it.each([null, undefined, 0, 'supported', [], { '0x1': null }, { '0x1': [] }, { '0x0': true }, { '0x01': positive['0x1'] }])('rejects malformed or non-canonical response %#', value => {
    expect(parseWalletCapabilities(value, 1)).toEqual(unknown);
  });
  it('accepts hex case but rejects multiple aliases for the requested chain', () => {
    expect(parseWalletCapabilities({ '0xA': positive['0x1'] }, 10)).toEqual({ atomic: 'supported', paymaster: 'supported' });
    expect(parseWalletCapabilities({ '0xA': positive['0x1'], '0xa': positive['0x1'] }, 10)).toEqual(unknown);
  });
  it('requires own capability fields, not prototype inheritance', () => {
    expect(parseWalletCapabilities(Object.create(positive), 1)).toEqual(unknown);
    expect(parseWalletCapabilities({ '0x1': { atomic: Object.create({ status: 'supported' }), paymasterService: Object.create({ supported: true }) } }, 1)).toEqual(unknown);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid target chain %s', chain => {
    expect(parseWalletCapabilities(positive, chain)).toEqual(unknown);
  });
  it('does not coerce an object-valued atomic status into a positive result', () => {
    const toString = vi.fn(() => 'supported');
    expect(parseWalletCapabilities({ '0x1': { atomic: { status: { toString } } } }, 1)).toEqual(unknown);
    expect(toString).not.toHaveBeenCalled();
  });
  it('does not throw when malformed atomic status cannot be coerced', () => {
    expect(parseWalletCapabilities({ '0x1': { atomic: { status: Object.create(null) } } }, 1)).toEqual(unknown);
  });
});

describe('account, chain, and provider-bound read-only inspection', () => {
  it('binds every read to the original provider and uses only the standard read methods', async () => {
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'checked', atomic: 'supported', paymaster: 'supported' });
    expect(selected.request.mock.calls.map(([arg]) => arg)).toEqual([
      { method: 'eth_accounts' }, { method: 'eth_chainId' }, { method: 'wallet_getCapabilities', params: [source, ['0x1']] },
      { method: 'eth_accounts' }, { method: 'eth_chainId' },
    ]);
    expect(selected.listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(network).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled(); expect(storage.getItem).not.toHaveBeenCalled();
  });
  it.each([-32601, 4200])('reports unsupported RPC method code %s without claiming the capabilities are unsupported', async code => {
    selected.setAnswer(() => { throw { code }; });
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'unsupported_method', ...unknown });
  });
  it.each([4001, -32000, '4200'])('treats rejected, failed, or malformed RPC code %s as unavailable', async code => {
    selected.setAnswer(() => { throw { code, message: 'TEST_ONLY_UNTRUSTED_PRIVATE_TEXT' }; });
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'unavailable', ...unknown });
  });
  it('allows a checked unknown result for an unrecognized response without using other chains', async () => {
    selected.setAnswer(() => ({ '0x89': positive['0x1'] }));
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'checked', ...unknown });
  });
  it.each([
    { sourceToken: other }, { sourceChainId: 137 }, { decimals: 18 }, { walletType: 'tron' }, { id: 'TEST_ONLY_UNREVIEWED_ROUTE' },
  ])('rejects an altered route identity before contacting any wallet: %j', async change => {
    expect(await inspectWalletCapabilities({ ...route, ...change } as Route, source)).toEqual({ state: 'unavailable', ...unknown });
    expect(selected.request).not.toHaveBeenCalled();
  });
  it('rejects invalid addresses, missing providers and an already-aborted request without RPC', async () => {
    expect(await inspectWalletCapabilities(route, 'not-an-address')).toEqual({ state: 'unavailable', ...unknown });
    const controller = new AbortController(); controller.abort();
    expect(await inspectWalletCapabilities(route, source, controller.signal)).toEqual({ state: 'cancelled', ...unknown });
    vi.mocked(wallets.evmProvider).mockImplementation(() => { throw new Error('No injected wallet'); });
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'unavailable', ...unknown });
    expect(selected.request).not.toHaveBeenCalled();
  });
  it.each(['on', 'removeListener'] as const)('requires the %s event API to guarantee context invalidation', async missing => {
    Reflect.deleteProperty(selected.provider, missing);
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'unavailable', ...unknown });
    expect(selected.request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('contains listener registration failure without starting any wallet RPC', async () => {
    selected.provider.on = () => { throw new Error('TEST_ONLY_BROKEN_PROVIDER'); };
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'unavailable', ...unknown });
    expect(selected.request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('contains each cleanup failure and still removes the other listeners', async () => {
    const remove = selected.provider.removeListener!;
    const attempted: string[] = [];
    selected.provider.removeListener = (name, callback) => { attempted.push(name); remove(name, callback); if (name === 'accountsChanged') throw new Error('TEST_ONLY_CLEANUP_FAILURE'); };
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'checked', atomic: 'supported', paymaster: 'supported' });
    expect(attempted).toEqual(['accountsChanged', 'chainChanged', 'disconnect']); expect(selected.listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['0x89', '1', '0x01', 1, null])('rejects wrong or malformed current chain %s before capability RPC', async value => {
    selected.setChain(value);
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'context_changed', ...unknown });
    expect(selected.request.mock.calls.every(([arg]) => arg.method !== 'wallet_getCapabilities')).toBe(true);
  });
  it.each([[], [other], null, { 0: source }])('rejects a missing or changed current account %#', async value => {
    selected.setAccounts(value);
    expect(await inspectWalletCapabilities(route, source)).toEqual({ state: 'context_changed', ...unknown });
    expect(selected.request.mock.calls.map(([arg]) => arg.method)).toEqual(['eth_accounts']);
  });
  it.each(['accountsChanged', 'chainChanged', 'disconnect'])('latches %s so switching away and back cannot revive a pending positive result', async event => {
    const pending = deferred<unknown>(); const original = selected; original.setAnswer(() => pending.promise);
    const inspection = inspectWalletCapabilities(route, source); await reachCapabilityRequest(original);
    original.emit(event, event === 'accountsChanged' ? [other] : '0x89');
    original.emit(event, event === 'accountsChanged' ? [source] : '0x1');
    expect(await inspection).toEqual({ state: 'context_changed', ...unknown });
    const count = original.request.mock.calls.length; pending.resolve(positive); await Promise.resolve(); await Promise.resolve();
    expect(original.request).toHaveBeenCalledTimes(count); expect(original.listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('checks accounts and chain again even when the provider omits events', async () => {
    for (const changed of ['account', 'chain']) {
      selected = providerFixture(); const pending = deferred<unknown>(); selected.setAnswer(() => pending.promise);
      const inspection = inspectWalletCapabilities(route, source); await reachCapabilityRequest(selected);
      if (changed === 'account') selected.setAccounts([other]); else selected.setChain('0x89');
      pending.resolve(positive); expect(await inspection).toEqual({ state: 'context_changed', ...unknown });
    }
  });
  it('refuses to continue on a newly selected provider or query it as fallback', async () => {
    const pending = deferred<unknown>(); const original = selected; original.setAnswer(() => pending.promise);
    const inspection = inspectWalletCapabilities(route, source); await reachCapabilityRequest(original);
    selected = providerFixture(); pending.resolve(positive);
    expect(await inspection).toEqual({ state: 'context_changed', ...unknown });
    expect(selected.request).not.toHaveBeenCalled(); expect(original.listenerCount()).toBe(0);
  });
  it.each(['timeout', 'cancel'] as const)('cleans up after %s and ignores the late wallet answer', async reason => {
    const pending = deferred<unknown>(); const original = selected; original.setAnswer(() => pending.promise);
    const controller = new AbortController(); const inspection = inspectWalletCapabilities(route, source, controller.signal);
    await reachCapabilityRequest(original);
    if (reason === 'cancel') controller.abort(); else await vi.advanceTimersByTimeAsync(8_001);
    expect(await inspection).toEqual({ state: reason === 'cancel' ? 'cancelled' : 'unavailable', ...unknown });
    const count = original.request.mock.calls.length; pending.resolve(positive); await Promise.resolve(); await Promise.resolve();
    expect(original.request).toHaveBeenCalledTimes(count); expect(original.listenerCount()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(network).not.toHaveBeenCalled(); expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('bounds the entire inspection including a stalled initial context read', async () => {
    selected.request.mockImplementationOnce(() => new Promise(() => {}));
    const inspection = inspectWalletCapabilities(route, source); await vi.advanceTimersByTimeAsync(8_001);
    expect(await inspection).toEqual({ state: 'unavailable', ...unknown });
    expect(selected.request.mock.calls.map(([arg]) => arg.method)).toEqual(['eth_accounts']); expect(selected.listenerCount()).toBe(0);
  });
});
