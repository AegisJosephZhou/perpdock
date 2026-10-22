import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvm, disconnectEvm, evmProvider, getEvmChain, isWalletConnectSelected, listEvmWallets, sourceNativeBalance, type BrowserProvider } from '../client/wallets.js';
import { connectWalletConnect, disconnectWalletConnect, WALLETCONNECT_RPC_MAP, WALLETCONNECT_TIMEOUT_MS } from '../client/walletconnect.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';

const { init, cores } = vi.hoisted(() => ({ init: vi.fn(), cores: [] as { heartbeat: { stop: ReturnType<typeof vi.fn> }; relayer: { transportClose: ReturnType<typeof vi.fn> } }[] }));
vi.mock('@walletconnect/ethereum-provider', () => ({ EthereumProvider: { init } }));
vi.mock('@walletconnect/core', () => ({ Core: class {
  heartbeat = { stop: vi.fn() }; relayer = { transportClose: vi.fn(async () => {}) };
  constructor() { cores.push(this); }
} }));
const account = '0x1111111111111111111111111111111111111111';
const projectId = 'a'.repeat(32); // TEST ONLY, never sent to a real service.
const uri = `wc:${'b'.repeat(64)}@2?relay-protocol=irn&symKey=${'c'.repeat(64)}`;
const options = (extra = {}) => ({ projectId, chainId: 1, onUri: vi.fn(), ...extra });
type Listener = (...args: unknown[]) => void;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function sdkFixture() {
  const events = new Map<string, Set<Listener>>();
  const sdk = {
    accounts: [account] as string[], chainId: 1, session: undefined as { topic: string } | undefined,
    emit(name: string, ...args: unknown[]) { for (const listener of [...events.get(name) ?? []]) listener(...args); },
    on(name: string, listener: Listener) { const set = events.get(name) || new Set<Listener>(); set.add(listener); events.set(name, set); },
    removeListener(name: string, listener: Listener) { events.get(name)?.delete(listener); },
    connect: vi.fn(async () => { sdk.emit('display_uri', uri); sdk.session = { topic: 'TEST_ONLY_SESSION' }; }),
    disconnect: vi.fn(async () => { sdk.session = undefined; sdk.emit('disconnect', { code: 4900 }); }),
    request: vi.fn(async ({ method }: { method: string; params?: unknown }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return sdk.accounts;
      // Actual SDK 2.26 UniversalProvider returns a number here, unlike an
      // injected EIP-1193 provider; the adapter must normalize the boundary.
      if (method === 'eth_chainId') return sdk.chainId;
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      throw new Error(`Unexpected TEST_ONLY request: ${method}`);
    }),
    signer: { cleanupPendingPairings: vi.fn(async () => {}), client: { core: {
      heartbeat: { stop: vi.fn() }, relayer: { transportClose: vi.fn(async () => {}) },
    } } },
  };
  return sdk;
}
function injected() {
  const request = vi.fn(async ({ method }: { method: string }) => method === 'eth_chainId' ? '0x1' : [account]);
  return { request: request as BrowserProvider['request'], isMetaMask: true };
}
async function settle() { await vi.dynamicImportSettled(); for (let i = 0; i < 12; i++) await Promise.resolve(); }
let page: Window;
beforeEach(() => {
  vi.useFakeTimers(); init.mockReset(); cores.length = 0;
  page = Object.assign(new EventTarget(), { location: { origin: 'https://funding.perpex.ai' } }) as unknown as Window;
  vi.stubGlobal('window', page);
});
afterEach(async () => { await disconnectWalletConnect(); await settle(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('WalletConnect SDK boundary and pinned wallet lifecycle', () => {
  it('stays passive until an explicit connection and rejects missing config or unsupported networks before loading the SDK', async () => {
    expect(listEvmWallets()).toEqual([]); expect(init).not.toHaveBeenCalled();
    await expect(connectWalletConnect(options({ projectId: '' }))).rejects.toThrow(/配置.*Project ID/);
    await expect(connectWalletConnect(options({ chainId: 728126428 }))).rejects.toThrow(/TronLink/);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(connectWalletConnect(options({ signal: cancelled.signal }))).rejects.toThrow(/取消/);
    expect(init).not.toHaveBeenCalled(); expect(page.ethereum).toBeUndefined();
  });
  it('connects without an injected wallet, publishes the URI, and requests only reviewed chains and necessary methods', async () => {
    const sdk = sdkFixture(); init.mockResolvedValue(sdk); const opts = options();
    expect(await connectEvm('walletconnect', opts)).toBe(account);
    expect(opts.onUri).toHaveBeenCalledWith(uri); expect(page.ethereum).toBeUndefined(); expect(listEvmWallets()).toEqual([]);
    expect(isWalletConnectSelected()).toBe(true); expect(await getEvmChain()).toBe(1);
    const config = init.mock.calls[0]![0];
    expect(config).toMatchObject({ projectId, chains: [1], showQrModal: false, telemetryEnabled: false, logger: 'silent', relayUrl: 'wss://relay.walletconnect.org' });
    expect(new Set([1, ...config.optionalChains])).toEqual(new Set([1, 42161, 8453, 10, 137, 56]));
    expect(config.metadata).toMatchObject({ name: 'Dock by Perpex', url: page.location.origin });
    expect(config.rpcMap).toEqual(WALLETCONNECT_RPC_MAP); expect(Object.values(config.rpcMap).every(url => typeof url === 'string' && url.startsWith('https://'))).toBe(true);
    expect(config.methods).toEqual(['eth_sendTransaction']); expect(config.optionalMethods).toEqual(['wallet_switchEthereumChain', 'wallet_getCapabilities']);
    expect(await config.storage.getKeys()).toEqual([]);
    expect(sdk.request.mock.calls.every(([request]) => ['eth_accounts', 'eth_chainId'].includes(request.method))).toBe(true);
  });
  it('keeps browser providers discoverable without replacing injection or falling back during execution', async () => {
    const browser = injected(); page.ethereum = browser;
    const sdk = sdkFixture(); init.mockResolvedValue(sdk);
    await connectEvm('walletconnect', options()); const selected = evmProvider();
    expect(listEvmWallets()).toEqual([{ id: expect.any(String), name: 'MetaMask' }]); expect(page.ethereum).toBe(browser);
    page.ethereum = injected();
    expect(await sourceNativeBalance(REVIEWED_EVM_SOURCES[0]!.route, account)).toBe('1'); expect(evmProvider()).toBe(selected);
    expect(browser.request).not.toHaveBeenCalled(); expect(page.ethereum.request).not.toHaveBeenCalled();
    sdk.session = undefined; sdk.emit('disconnect', { code: 4900 });
    await expect(getEvmChain()).rejects.toThrow(/断开/); expect(page.ethereum.request).not.toHaveBeenCalled();
    expect(sdk.signer.client.core.heartbeat.stop).toHaveBeenCalled();
  });
  it.each([1, 42161, 8453, 10, 137, 56])('normalizes actual SDK numeric chain %s before all existing wallet checks', async chainId => {
    const sdk = sdkFixture(); sdk.chainId = chainId; init.mockResolvedValue(sdk);
    await connectEvm('walletconnect', options({ chainId }));
    expect(await evmProvider().request({ method: 'eth_chainId' })).toBe(`0x${chainId.toString(16)}`);
    expect(await getEvmChain()).toBe(chainId);
    const route = REVIEWED_EVM_SOURCES.find(entry => entry.route.sourceChainId === chainId)!.route;
    expect(await sourceNativeBalance(route, account)).toBe('1');
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0x01', '1', 'invalid'])('rejects malformed SDK chain value %s at the adapter boundary', async chain => {
    const sdk = sdkFixture(); const request = sdk.request.getMockImplementation()!;
    sdk.request.mockImplementation(async args => args.method === 'eth_chainId' ? chain as number : request(args)); init.mockResolvedValue(sdk);
    await expect(connectEvm('walletconnect', options())).rejects.toThrow(/有效网络编号/);
    expect(sdk.disconnect).toHaveBeenCalled();
  });
  it('selects the injected wallet only after an explicit default-browser connect following WalletConnect', async () => {
    const browser = injected(); page.ethereum = browser;
    const sdk = sdkFixture(); init.mockResolvedValue(sdk);
    await connectEvm('walletconnect', options());
    await connectEvm();
    expect(evmProvider()).toBe(browser); expect(isWalletConnectSelected()).toBe(false);
    expect(browser.request).toHaveBeenCalledWith({ method: 'eth_requestAccounts' }); expect(sdk.disconnect).toHaveBeenCalled();
  });
  it('blocks reads after explicit disconnect until the user explicitly reconnects', async () => {
    const sdk = sdkFixture(); init.mockResolvedValue(sdk); page.ethereum = injected();
    await connectEvm('walletconnect', options()); await disconnectEvm();
    expect(() => evmProvider()).toThrow(/断开/); expect(page.ethereum.request).not.toHaveBeenCalled();
    expect(sdk.signer.client.core.relayer.transportClose).toHaveBeenCalled();
    await connectEvm(); expect(evmProvider()).toBe(page.ethereum);
  });
  it('forwards current account/chain changes and blocks unsupported signing methods', async () => {
    const sdk = sdkFixture(); init.mockResolvedValue(sdk); await connectEvm('walletconnect', options());
    const provider = evmProvider(); const accounts = vi.fn(); const chains = vi.fn();
    provider.on?.('accountsChanged', accounts); provider.on?.('chainChanged', chains);
    sdk.emit('accountsChanged', [account]); sdk.emit('chainChanged', '0xa');
    expect(accounts).toHaveBeenCalledWith([account]); expect(chains).toHaveBeenCalledWith('0xa');
    provider.removeListener?.('chainChanged', chains); sdk.emit('chainChanged', '0x1'); expect(chains).toHaveBeenCalledTimes(1);
    await expect(provider.request({ method: 'personal_sign', params: ['0x00', account] })).rejects.toThrow(/未启用/);
    await expect(provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }] })).rejects.toThrow(/审核/);
    sdk.emit('accountsChanged', []); await expect(getEvmChain()).rejects.toThrow(/断开/);
  });
  it.each(['init', 'approval'] as const)('cancels during %s, permits retry, and never pins a late prior completion', async phase => {
    const old = sdkFixture(); const next = sdkFixture(); const pending = deferred<ReturnType<typeof sdkFixture>>(); const approval = deferred<void>();
    if (phase === 'init') init.mockImplementationOnce(() => pending.promise);
    else { old.connect.mockImplementationOnce(async () => { old.emit('display_uri', uri); await approval.promise; old.session = { topic: 'LATE_OLD_SESSION' }; }); init.mockResolvedValueOnce(old); }
    init.mockResolvedValueOnce(next);
    const controller = new AbortController(); const oldOptions = options({ signal: controller.signal });
    const first = connectEvm('walletconnect', oldOptions); const rejected = expect(first).rejects.toThrow(/取消/);
    await settle(); controller.abort(); await rejected;
    expect(await connectEvm('walletconnect', options())).toBe(account); const selected = evmProvider();
    const uriCalls = oldOptions.onUri.mock.calls.length;
    if (phase === 'init') pending.resolve(old); else approval.resolve();
    await settle(); old.emit('display_uri', uri); await settle();
    expect(evmProvider()).toBe(selected); expect(await getEvmChain()).toBe(1); expect(oldOptions.onUri).toHaveBeenCalledTimes(uriCalls);
    expect(old.disconnect).toHaveBeenCalled(); expect(old.signer.client.core.heartbeat.stop).toHaveBeenCalled();
    expect(old.signer.client.core.relayer.transportClose).toHaveBeenCalled();
    expect(next.disconnect).not.toHaveBeenCalled();
    expect(init.mock.calls[0]![0].customStoragePrefix).not.toBe(init.mock.calls[1]![0].customStoragePrefix);
    expect(init.mock.calls[0]![0].storage).not.toBe(init.mock.calls[1]![0].storage);
  });
  it('times out a pending approval and stops heartbeat/transport even when SDK disconnect never settles', async () => {
    const sdk = sdkFixture(); sdk.connect.mockImplementation(() => new Promise(() => {})); sdk.disconnect.mockImplementation(() => new Promise(() => {})); init.mockResolvedValue(sdk);
    const pending = connectEvm('walletconnect', options()); const rejected = expect(pending).rejects.toThrow(/超时/);
    await settle(); await vi.advanceTimersByTimeAsync(WALLETCONNECT_TIMEOUT_MS); await rejected;
    expect(sdk.signer.client.core.heartbeat.stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000); expect(sdk.signer.client.core.relayer.transportClose).toHaveBeenCalled();
    expect(() => evmProvider()).toThrow(/未检测到/);
  });
  it('stops its owned Core when SDK initialization never resolves', async () => {
    init.mockImplementation(() => new Promise(() => {}));
    const pending = connectEvm('walletconnect', options()); const rejected = expect(pending).rejects.toThrow(/超时/);
    await settle(); expect(cores).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(WALLETCONNECT_TIMEOUT_MS); await rejected;
    expect(cores[0]!.heartbeat.stop).toHaveBeenCalled(); expect(cores[0]!.relayer.transportClose).toHaveBeenCalled();
    expect(() => evmProvider()).toThrow(/未检测到/);
  });
  it('allows a fresh attempt after init failure or wallet rejection without exposing raw SDK errors', async () => {
    init.mockRejectedValueOnce(new Error('WalletConnect secret relay internals'));
    await expect(connectEvm('walletconnect', options())).rejects.toThrow('WalletConnect 连接失败，请检查手机钱包、网络和本站配置后重试。');
    const rejected = sdkFixture(); rejected.connect.mockRejectedValueOnce({ code: 4001, message: 'User rejected' }); init.mockResolvedValueOnce(rejected);
    await expect(connectEvm('walletconnect', options())).rejects.toThrow(/拒绝或取消/);
    const valid = sdkFixture(); init.mockResolvedValueOnce(valid); expect(await connectEvm('walletconnect', options())).toBe(account);
    expect(evmProvider()).not.toBe(page.ethereum);
  });
  it.each(['account', 'chain'] as const)('rejects invalid %s returned by a new or SDK-restored session before pinning', async mismatch => {
    const browser = injected(); page.ethereum = browser; await connectEvm();
    const sdk = sdkFixture(); sdk.session = { topic: 'SDK_RESTORED_FIXTURE' };
    if (mismatch === 'account') sdk.accounts = ['invalid']; else sdk.chainId = 10;
    init.mockResolvedValue(sdk);
    await expect(connectEvm('walletconnect', options())).rejects.toThrow(mismatch === 'account' ? /有效账户/ : /网络.*不一致/);
    expect(evmProvider()).toBe(browser); expect(sdk.disconnect).toHaveBeenCalled();
  });
  it('cancels pending WalletConnect when the user explicitly chooses an injected wallet', async () => {
    page.ethereum = injected(); const sdk = sdkFixture(); const pending = deferred<void>();
    sdk.connect.mockImplementation(async () => { await pending.promise; sdk.session = { topic: 'LATE' }; }); init.mockResolvedValue(sdk);
    const connecting = connectEvm('walletconnect', options()); const rejected = expect(connecting).rejects.toThrow(/取消/);
    await settle(); await connectEvm(); await rejected;
    pending.resolve(); await settle(); expect(evmProvider()).toBe(page.ethereum); expect(sdk.disconnect).toHaveBeenCalled();
  });
});
