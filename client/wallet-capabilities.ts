import { isAddress, type Address, type Hex } from 'viem';
import type { Route } from '../shared/types.js';
import { reviewedEvmSource } from '../shared/route-registry.js';
import { evmProvider, type BrowserProvider } from './wallets.js';

export type AtomicCapability = 'supported' | 'ready' | 'unsupported' | 'unknown';
export type PaymasterCapability = 'supported' | 'unsupported' | 'unknown';
export interface WalletCapabilities {
  atomic: AtomicCapability;
  paymaster: PaymasterCapability;
}
export interface CapabilityInspection extends WalletCapabilities {
  state: 'checked' | 'unsupported_method' | 'unavailable' | 'context_changed' | 'cancelled';
}
const unknownCapabilities: WalletCapabilities = { atomic: 'unknown', paymaster: 'unknown' };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key) ? value[key] : undefined;

/** EIP-5792 + ERC-7677 reports are observations, never permission to spend.
 * A per-chain value overrides the same global capability, even when malformed.
 * Missing/legacy/other-chain values must not become a positive capability. */
export function parseWalletCapabilities(value: unknown, chainId: number): WalletCapabilities {
  if (!record(value) || !Number.isSafeInteger(chainId) || chainId <= 0) return { ...unknownCapabilities };
  const chain = `0x${chainId.toString(16)}`;
  const globals = own(value, '0x0');
  const matches = Object.keys(value).filter(key => key.toLowerCase() === chain);
  if (matches.length > 1) return { ...unknownCapabilities };
  const specific = matches.length === 1 ? own(value, matches[0]) : undefined;
  if ((globals !== undefined && !record(globals)) || (matches.length && !record(specific))) return { ...unknownCapabilities };
  const capability = (name: string) => record(specific) && Object.hasOwn(specific, name)
    ? specific[name] : record(globals) ? own(globals, name) : undefined;
  const atomic = capability('atomic');
  const paymaster = capability('paymasterService');
  const atomicStatus = record(atomic) ? own(atomic, 'status') : undefined;
  return {
    atomic: typeof atomicStatus === 'string' && ['supported', 'ready', 'unsupported'].includes(atomicStatus)
      ? atomicStatus as AtomicCapability : 'unknown',
    paymaster: record(paymaster) && typeof own(paymaster, 'supported') === 'boolean'
      ? paymaster.supported ? 'supported' : 'unsupported' : 'unknown',
  };
}

class InspectionStopped extends Error {
  constructor(readonly state: CapabilityInspection['state']) { super(state); }
}

/** On-demand read only. No account request, upgrade, signature, paymaster RPC,
 * transaction, storage write, or fallback to a different provider is permitted. */
export async function inspectWalletCapabilities(route: Route, source: string, signal?: AbortSignal): Promise<CapabilityInspection> {
  const entry = reviewedEvmSource(route.id);
  if (signal?.aborted) return { state: 'cancelled', ...unknownCapabilities };
  if (!entry || route.walletType !== 'evm' || route.sourceChainId !== entry.route.sourceChainId ||
    route.sourceToken.toLowerCase() !== entry.route.sourceToken.toLowerCase() || route.decimals !== entry.route.decimals || !isAddress(source)) {
    return { state: 'unavailable', ...unknownCapabilities };
  }
  let provider: BrowserProvider;
  try { provider = evmProvider(); } catch { return { state: 'unavailable', ...unknownCapabilities }; }
  // Snapshot reads alone miss an account/chain switching away and back while
  // the capability request is pending. Do not issue positive reports without events.
  if (typeof provider.on !== 'function' || typeof provider.removeListener !== 'function') return { state: 'unavailable', ...unknownCapabilities };
  let stopped: CapabilityInspection['state'] | undefined;
  let rejectStop: (reason: InspectionStopped) => void = () => {};
  const stopPromise = new Promise<never>((_, reject) => { rejectStop = reject; });
  const stop = (state: CapabilityInspection['state']) => {
    if (stopped) return;
    stopped = state;
    rejectStop(new InspectionStopped(state));
  };
  const changed = () => stop('context_changed');
  const cancelled = () => stop('cancelled');
  const timer = setTimeout(() => stop('unavailable'), 8_000);
  const guard = () => {
    if (stopped) throw new InspectionStopped(stopped);
    if (signal?.aborted) throw new InspectionStopped('cancelled');
    if (evmProvider() !== provider) throw new InspectionStopped('context_changed');
  };
  const verify = async () => {
    guard();
    const accounts = await provider.request({ method: 'eth_accounts' });
    guard();
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== source.toLowerCase()) throw new InspectionStopped('context_changed');
    const network = await provider.request({ method: 'eth_chainId' });
    guard();
    if (typeof network !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(network) || BigInt(network) !== BigInt(route.sourceChainId)) throw new InspectionStopped('context_changed');
  };
  try {
    for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) provider.on(name, changed);
    signal?.addEventListener('abort', cancelled, { once: true });
    const run = async (): Promise<CapabilityInspection> => {
      await verify();
      let raw: unknown;
      try {
        raw = await provider.request({ method: 'wallet_getCapabilities', params: [source as Address, [`0x${route.sourceChainId.toString(16)}` as Hex]] });
      } catch (error) {
        guard();
        const code = record(error) ? own(error, 'code') : undefined;
        if (code === -32601 || code === 4200) throw new InspectionStopped('unsupported_method');
        throw new InspectionStopped('unavailable');
      }
      await verify();
      return { state: 'checked', ...parseWalletCapabilities(raw, route.sourceChainId) };
    };
    return await Promise.race([run(), stopPromise]);
  } catch (error) {
    return { state: error instanceof InspectionStopped ? error.state : 'unavailable', ...unknownCapabilities };
  } finally {
    stopped ??= 'cancelled'; // Late wallet responses cannot start another read.
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelled);
    for (const name of ['accountsChanged', 'chainChanged', 'disconnect']) {
      try { provider.removeListener(name, changed); } catch { /* Never expose a third-party cleanup exception. */ }
    }
  }
}
