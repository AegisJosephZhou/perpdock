import type { StoredQuote, SourceVerification } from '../../shared/types.js';
import { reviewedEvmSource } from '../../shared/route-registry.js';
import { verifyEvmSource } from './evm.js';
import { evmRpcUrl } from './evm-rpc.js';

// Retain the published Ethereum wrapper and constants for existing integrations/tests.
export const ETHEREUM_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const ETHEREUM_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
export function ethereumRpcUrl(): string { return evmRpcUrl('ethereum-usdt-hypercore'); }
export async function verifyEthereumSource(quote: StoredQuote, txHash: string): Promise<SourceVerification> {
  if (reviewedEvmSource(quote.routeId)?.route.sourceChainId !== 1) return { valid: false, reason: '订单网络不是 Ethereum 主网。' };
  return verifyEvmSource(quote, txHash);
}
