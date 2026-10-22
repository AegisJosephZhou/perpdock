import { isAddress } from 'viem';
import type EthereumProvider from '@walletconnect/ethereum-provider';
import type { EthereumProviderOptions } from '@walletconnect/ethereum-provider';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { BrowserProvider } from './wallets.js';

export interface WalletConnectOptions {
  projectId: string;
  chainId: number;
  onUri: (uri: string) => void;
  signal?: AbortSignal;
}
export const WALLETCONNECT_TIMEOUT_MS = 120_000;
export const WALLETCONNECT_RPC_MAP: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(
  REVIEWED_EVM_SOURCES.map(source => [source.route.sourceChainId, source.publicRpcUrl]),
));
type Listener = (...args: unknown[]) => void;
interface Connection { provider: BrowserProvider; close: () => Promise<void> }
type CoreHandle = EthereumProvider['signer']['client']['core'];
interface State { pending?: (error: Error) => void; active?: Connection }
const states = new WeakMap<Window, State>();
function state(): State {
  let value = states.get(window);
  if (!value) { value = {}; states.set(window, value); }
  return value;
}
class WalletConnectError extends Error {}
function cancelled() { return new WalletConnectError('WalletConnect 连接已取消，请重新扫码连接。'); }
function disconnected() { return new WalletConnectError('WalletConnect 已断开，请重新扫码连接钱包。'); }
function normalizedChain(value: unknown): `0x${string}` {
  // UniversalProvider 2.26 returns a number for eth_chainId. Normalize only
  // this SDK boundary; the transaction layer keeps strict EIP-1193 quantities.
  const chain = typeof value === 'number' ? value : typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(chain) || chain <= 0) throw new WalletConnectError('WalletConnect 未返回有效网络编号，请重新连接。');
  return `0x${chain.toString(16)}`;
}

// Each explicit attempt has its own memory-only session. SDK 2.26's
// abortPairingAttempt is a no-op; a late approval must never overwrite a retry.
// No existing wallet session storage is read, cleared or silently restored.
function memoryStorage(): NonNullable<EthereumProviderOptions['storage']> {
  const values = new Map<string, unknown>();
  return {
    async getKeys() { return [...values.keys()]; },
    async getEntries<T>() { return [...values.entries()] as [string, T][]; },
    async getItem<T>(key: string) { return values.get(key) as T | undefined; },
    async setItem<T>(key: string, value: T) { values.set(key, value); },
    async removeItem(key: string) { values.delete(key); },
  };
}
async function boundedCleanup(provider: EthereumProvider): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const core = provider.signer?.client?.core;
  // Stop heartbeats immediately, even if the relay is offline and disconnect hangs.
  core?.heartbeat?.stop();
  const cleanup = (async () => {
    try { await provider.disconnect(); } catch { /* Local invalidation is authoritative. */ }
    try { await provider.signer?.cleanupPendingPairings({ deletePairings: true }); } catch { /* Best effort. */ }
  })();
  try { await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); })]); }
  finally {
    clearTimeout(timer);
    // Core has no stop() in SDK 2.26. This explicitly closes its transport and
    // prevents automatic reconnect; this core belongs only to this attempt.
    void core?.relayer?.transportClose().catch(() => {});
  }
}

const allowedMethods = new Set(['eth_accounts', 'eth_requestAccounts', 'eth_chainId', 'eth_call', 'eth_getBalance',
  'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getBlockByNumber',
  'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_getCapabilities']);
function guardedProvider(sdk: EthereumProvider): Connection {
  let live = true;
  const listeners = new Map<string, Set<Listener>>();
  const emit = (event: string, ...args: unknown[]) => { for (const fn of [...listeners.get(event) ?? []]) fn(...args); };
  const onDisconnect = (...args: unknown[]) => { if (live) { live = false; emit('disconnect', ...args); void boundedCleanup(sdk); } };
  const onAccounts = (...args: unknown[]) => {
    if (!live) return;
    emit('accountsChanged', ...args);
    if (!Array.isArray(args[0]) || args[0].length === 0) onDisconnect({ code: 4900, message: disconnected().message });
  };
  const onChain = (...args: unknown[]) => {
    if (!live) return;
    try { emit('chainChanged', normalizedChain(args[0])); }
    catch { onDisconnect({ code: 4900, message: 'WalletConnect 网络编号无效，请重新连接。' }); }
  };
  sdk.on('disconnect', onDisconnect); sdk.on('accountsChanged', onAccounts); sdk.on('chainChanged', onChain);
  const provider: BrowserProvider = {
    request: (async (args: { method: string; params?: unknown }) => {
      if (!live || !sdk.session) throw disconnected();
      if (!allowedMethods.has(args.method)) throw new WalletConnectError('当前 WalletConnect 连接未启用此钱包操作。');
      if (args.method === 'wallet_switchEthereumChain') {
        const next = Array.isArray(args.params) ? args.params[0]?.chainId : undefined;
        if (typeof next !== 'string' || !/^0x[0-9a-f]+$/i.test(next) || !WALLETCONNECT_RPC_MAP[Number.parseInt(next, 16)]) throw new WalletConnectError('请求的网络不在当前已审核入金范围。');
      }
      const result = await sdk.request(args as Parameters<EthereumProvider['request']>[0]);
      return args.method === 'eth_chainId' ? normalizedChain(result) : result;
    }) as BrowserProvider['request'],
    on(event, listener) { const set = listeners.get(event) || new Set<Listener>(); set.add(listener); listeners.set(event, set); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  return { provider, async close() {
    onDisconnect({ code: 4900, message: disconnected().message });
    sdk.removeListener('disconnect', onDisconnect); sdk.removeListener('accountsChanged', onAccounts); sdk.removeListener('chainChanged', onChain);
    listeners.clear();
    await boundedCleanup(sdk);
  } };
}

export async function connectWalletConnect(options: WalletConnectOptions): Promise<BrowserProvider> {
  if (!/^[a-f0-9]{32}$/i.test(options.projectId || '')) throw new WalletConnectError('本站尚未配置有效的 WalletConnect Project ID，请联系部署团队完成配置。');
  if (!WALLETCONNECT_RPC_MAP[options.chainId]) throw new WalletConnectError('WalletConnect 仅支持当前已审核的 EVM 主网；Tron 请使用 TronLink。');
  if (options.signal?.aborted) throw cancelled();
  const current = state();
  current.pending?.(cancelled());
  if (current.active) { void current.active.close(); current.active = undefined; }
  let live = true;
  let sdk: EthereumProvider | undefined;
  let core: CoreHandle | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation!: (reason: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  const cleanAttempt = () => {
    if (sdk) void boundedCleanup(sdk);
    else {
      // Hold Core before awaiting SDK init, so an init that hangs or rejects
      // cannot hide its heartbeat/relay behind an unresolved provider promise.
      core?.heartbeat.stop();
      void core?.relayer.transportClose().catch(() => {});
    }
  };
  const cancel = (error: Error) => {
    if (!live) return;
    live = false; rejectCancellation(error);
    cleanAttempt();
  };
  const onAbort = () => cancel(cancelled());
  current.pending = cancel;
  options.signal?.addEventListener('abort', onAbort, { once: true });
  timer = setTimeout(() => cancel(new WalletConnectError('WalletConnect 连接超时，请检查手机钱包和网络后重新扫码。')), WALLETCONNECT_TIMEOUT_MS);
  const assertCurrent = () => { if (!live || current.pending !== cancel || options.signal?.aborted) throw cancelled(); };
  const onUri = (uri: string) => {
    if (!live || current.pending !== cancel) return;
    if (typeof uri !== 'string' || !uri.startsWith('wc:')) { cancel(new WalletConnectError('WalletConnect 未返回有效连接二维码，请重试。')); return; }
    options.onUri(uri);
  };
  const attempt = (async () => {
    const [{ EthereumProvider }, { Core }] = await Promise.all([import('@walletconnect/ethereum-provider'), import('@walletconnect/core')]);
    assertCurrent();
    const storage = memoryStorage(); const customStoragePrefix = `perpex-${crypto.randomUUID()}`;
    core = new Core({ projectId: options.projectId, relayUrl: 'wss://relay.walletconnect.org', storage, customStoragePrefix, telemetryEnabled: false, logger: 'silent' });
    sdk = await EthereumProvider.init({
      projectId: options.projectId,
      chains: [options.chainId],
      optionalChains: Object.keys(WALLETCONNECT_RPC_MAP).map(Number).filter(id => id !== options.chainId),
      methods: ['eth_sendTransaction'], optionalMethods: ['wallet_switchEthereumChain', 'wallet_getCapabilities'],
      events: ['chainChanged', 'accountsChanged'], optionalEvents: [],
      rpcMap: { ...WALLETCONNECT_RPC_MAP }, showQrModal: false, telemetryEnabled: false, logger: 'silent',
      disableProviderPing: true, relayUrl: 'wss://relay.walletconnect.org',
      storage, customStoragePrefix, core,
      metadata: { name: 'Dock by Perpex', description: 'Fund your own Hyperliquid default Perps account', url: window.location.origin, icons: [] },
    });
    assertCurrent();
    sdk.on('display_uri', onUri);
    await sdk.connect();
    assertCurrent();
    const accounts = await sdk.request<unknown>({ method: 'eth_accounts' });
    const chain = await sdk.request<unknown>({ method: 'eth_chainId' });
    assertCurrent();
    if (!sdk.session || !Array.isArray(accounts) || typeof accounts[0] !== 'string' || !isAddress(accounts[0])) throw new WalletConnectError('WalletConnect 未返回有效账户，请在手机钱包解锁并重新连接。');
    if (Number(normalizedChain(chain)) !== options.chainId) throw new WalletConnectError('WalletConnect 钱包网络与所选入金网络不一致，请在手机钱包核对后重新连接。');
    const connection = guardedProvider(sdk);
    current.active = connection;
    return connection.provider;
  })();
  try { return await Promise.race([attempt, cancellation]); }
  catch (error) {
    live = false;
    cleanAttempt();
    // Also clean an init/approval that resolves after cancellation or timeout.
    void attempt.catch(() => { if (sdk) void boundedCleanup(sdk); });
    if (error instanceof WalletConnectError) throw error;
    const value = error as { code?: number; message?: string };
    if (value?.code === 4001 || /reject|denied|declin|cancel/i.test(value?.message || '')) throw new WalletConnectError('已拒绝或取消 WalletConnect 连接，请确认后重新扫码。');
    throw new WalletConnectError('WalletConnect 连接失败，请检查手机钱包、网络和本站配置后重试。');
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
    sdk?.removeListener('display_uri', onUri);
    if (current.pending === cancel) current.pending = undefined;
  }
}

export async function disconnectWalletConnect(): Promise<void> {
  const current = state();
  current.pending?.(cancelled()); current.pending = undefined;
  const active = current.active; current.active = undefined;
  await active?.close();
}
