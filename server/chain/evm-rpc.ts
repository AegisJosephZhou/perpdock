import { z } from 'zod';
import { reviewedEvmSource } from '../../shared/route-registry.js';
import { postJson, UpstreamError } from './http.js';

const rpcEnvironment: Record<number, string> = { 1: 'ETHEREUM_RPC_URL', 42161: 'ARBITRUM_RPC_URL', 8453: 'BASE_RPC_URL', 10: 'OPTIMISM_RPC_URL', 137: 'POLYGON_RPC_URL', 56: 'BNB_RPC_URL' };
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const bytecode = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);
function reviewed(routeId: string) {
  const source = reviewedEvmSource(routeId);
  if (!source) throw new UpstreamError('UNSUPPORTED_ROUTE', '未审核的 EVM 来源路线。', 400);
  return source;
}

/** Operational configuration only. URLs are never read from requests or exposed in errors. */
export function evmRpcUrl(routeId: string): string {
  const source = reviewed(routeId);
  const env = rpcEnvironment[source.route.sourceChainId];
  if (!env) throw new UpstreamError('EVM_RPC_CONFIG', '来源链缺少审核过的 RPC 配置。', 503);
  let url: URL;
  try { url = new URL(process.env[env] || source.publicRpcUrl); }
  catch { throw new UpstreamError('EVM_RPC_CONFIG', '来源链 RPC 配置无效。', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new UpstreamError('EVM_RPC_CONFIG', '来源链 RPC 必须使用无 URL 凭据或片段的 HTTPS 地址。', 503);
  return url.href;
}

export async function evmRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown().optional(), error: z.unknown().optional() }).parse(await postJson(url, { jsonrpc: '2.0', id: 1, method, params }));
  if (envelope.error !== undefined || !Object.hasOwn(envelope, 'result')) throw new UpstreamError('EVM_RPC_ERROR', '来源链 RPC 尚未提供可靠结果，交易状态未改变。', 503);
  return envelope.result;
}

type Probe = { expiresAt: number; result: Promise<void> };
const networkProbes = new Map<string, Probe>();
const tokenProbes = new Map<string, Probe>();
function cachedProbe(cache: Map<string, Probe>, key: string, run: () => Promise<void>): Promise<void> {
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.result;
  const probe: Probe = { expiresAt: Infinity, result: Promise.resolve() };
  // Concurrent routes on the same chain share one probe, including a short failure cache.
  probe.result = Promise.resolve().then(run).then(
    () => { probe.expiresAt = Date.now() + 60_000; },
    error => { probe.expiresAt = Date.now() + 15_000; throw error; },
  );
  cache.set(key, probe);
  return probe.result;
}

/** Gate new quotes only. Tracking existing payments always continues through their reviewed RPC. */
export async function assertEvmSourceHealthy(routeId: string): Promise<void> {
  const { route, depository } = reviewed(routeId);
  const url = evmRpcUrl(routeId);
  const networkKey = `${route.sourceChainId}:${depository.toLowerCase()}:${url}`;
  await cachedProbe(networkProbes, networkKey, async () => {
    const [chainId, finalized, code] = await Promise.all([
      evmRpc(url, 'eth_chainId', []),
      evmRpc(url, 'eth_getBlockByNumber', ['finalized', false]),
      evmRpc(url, 'eth_getCode', [depository, 'latest']),
    ]);
    if (BigInt(quantity.parse(chainId)) !== BigInt(route.sourceChainId)) throw new UpstreamError('EVM_NETWORK_MISMATCH', '来源链 RPC 网络与审核配置不一致。', 503);
    z.object({ number: quantity, hash, transactions: z.array(hash) }).parse(finalized);
    bytecode.parse(code);
  });
  await cachedProbe(tokenProbes, `${networkKey}:${route.sourceToken.toLowerCase()}:${route.decimals}`, async () => {
    const [code, decimals] = await Promise.all([
      evmRpc(url, 'eth_getCode', [route.sourceToken, 'latest']),
      evmRpc(url, 'eth_call', [{ to: route.sourceToken, data: '0x313ce567' }, 'latest']),
    ]);
    bytecode.parse(code);
    if (BigInt(hash.parse(decimals)) !== BigInt(route.decimals)) throw new UpstreamError('EVM_TOKEN_MISMATCH', '链上代币精度与审核配置不一致。', 503);
  });
}
