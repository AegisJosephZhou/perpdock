import { z } from 'zod';
import { decodeFunctionData, encodeFunctionData, formatUnits, parseAbi, parseUnits, recoverMessageAddress, type Hex } from 'viem';
import { getOrderId, type VmType } from './order-hash.js';
import type { ProviderQuote, QuoteRequest, Route, StoredQuote, TrackedOrder, TrackingUpdate, WalletTransaction } from '../../shared/types.js';
import { fetchJson, postJson, UpstreamError } from '../chain/http.js';
import { TronIntent, tronHex, verifyTronSource } from '../chain/tron.js';
import { evmAddress, getAccount, scanPerpsCredit } from '../chain/hyperliquid.js';
import { verifyEthereumSource } from '../chain/ethereum.js';
import { verifyEvmSource } from '../chain/evm.js';
import { assertEvmSourceHealthy } from '../chain/evm-rpc.js';
import { REVIEWED_EVM_SOURCES, reviewedEvmSource } from '../../shared/route-registry.js';

const API = 'https://api.relay.link';
export const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const PERPS_USDC = '0x00000000000000000000000000000000';
export const TRON_DEPOSITORY = 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN';
const SOLVER = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
const sourceConfigs: { route: Route; protocolChain: string; depository: string }[] = [
  ...REVIEWED_EVM_SOURCES,
  { route: { id: 'tron-usdt-hypercore', label: 'Tron USDT → Hyperliquid Perps USDC', sourceChain: 'Tron', sourceChainId: 728126428, sourceToken: TRON_USDT, symbol: 'USDT', decimals: 6, walletType: 'tron', available: true, gasSymbol: 'TRX', assetNote: 'Tron 主网 TRC20 USDT。' }, protocolChain: 'tron', depository: TRON_DEPOSITORY },
];
function sourceConfig(routeId: string) {
  const config = sourceConfigs.find(c => c.route.id === routeId);
  if (!config) throw new UpstreamError('UNSUPPORTED_ROUTE', '当前仅支持已审核的稳定币入金路线。', 400);
  return config;
}
function sameSource(route: Route, a: string, b: string) { return route.walletType === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b; }
const integer = z.string().regex(/^\d+$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Currency = z.object({ chainId: z.number().int(), address: z.string(), decimals: z.number().int().min(0).max(18), symbol: z.string().max(30) });
const Amount = z.object({ currency: Currency, amount: integer, minimumAmount: integer.optional() });
const Payment = z.object({ recipient: z.string(), currency: z.string(), minimumAmount: integer, expectedAmount: integer });
const OrderDataSchema = z.object({
  version: z.literal('v1'), solverChainId: z.string(), solver: z.string(), salt: hex32,
  inputs: z.array(z.object({ payment: z.object({ chainId: z.string(), currency: z.string(), amount: integer, weight: integer }), refunds: z.array(z.object({ chainId: z.string(), recipient: z.string(), currency: z.string(), minimumAmount: integer, deadline: z.number().int(), extraData: z.string() })).max(4) })).length(1),
  output: z.object({ chainId: z.string(), payments: z.array(Payment).length(1), calls: z.array(z.unknown()).max(0), deadline: z.number().int(), extraData: z.string() }), fees: z.array(z.unknown()).max(0),
});
const EvmIntent = z.object({ from: z.string().regex(/^0x[0-9a-fA-F]{40}$/), to: z.string().regex(/^0x[0-9a-fA-F]{40}$/), data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/), value: integer, chainId: z.number().int().positive().safe(), gas: z.union([integer, z.number().int().nonnegative().safe()]).optional(), gasPrice: integer.optional(), maxFeePerGas: integer.optional(), maxPriorityFeePerGas: integer.optional() }).strict();
const QuoteSchema = z.object({ requestId: hex32, steps: z.array(z.object({ id: z.string(), kind: z.literal('transaction'), requestId: hex32, items: z.array(z.object({ data: z.unknown() })).length(1) })).min(1).max(2),
  details: z.object({ sender: z.string(), recipient: z.string(), currencyIn: Amount, currencyOut: Amount, timeEstimate: z.number().nonnegative().optional() }),
  fees: z.record(z.string(), Amount),
  protocol: z.object({ v2: z.object({ orderId: hex32, orderData: OrderDataSchema, orderSignature: z.string().regex(/^0x[0-9a-fA-F]{130}$/), paymentDetails: z.object({ chainId: z.string(), depository: z.string(), currency: z.string(), amount: integer }) }) }),
});
const ChainSchema = z.object({ id: z.number().int(), vmType: z.string(), disabled: z.boolean().optional(), depositEnabled: z.boolean().optional(), protocol: z.object({ v2: z.object({ chainId: z.string(), depository: z.string().optional() }).optional() }).optional() });
type Chain = z.infer<typeof ChainSchema>;
let chainCache: { expires: number; chains: Chain[] } | undefined;
const VM_TYPES: Record<string, VmType> = { evm: 'ethereum-vm', hypevm: 'hyperliquid-vm', tvm: 'tron-vm' };
const headers = (): Record<string, string> => process.env.RELAY_API_KEY ? { 'x-api-key': process.env.RELAY_API_KEY } : {};
async function chains(): Promise<Chain[]> {
  if (chainCache && chainCache.expires > Date.now()) return chainCache.chains;
  const data = z.object({ chains: z.array(ChainSchema) }).parse(await fetchJson(`${API}/chains`, { headers: headers() }));
  chainCache = { chains: data.chains, expires: Date.now() + 300_000 };
  return data.chains;
}
function requireMatch(condition: unknown, message: string): asserts condition { if (!condition) throw new UpstreamError('UNSAFE_PROVIDER_QUOTE', message); }
function sourceAmount(amount: string, route: Route): bigint {
  if (!/^\d{1,40}(\.\d+)?$/.test(amount) || (amount.split('.')[1]?.length ?? 0) > route.decimals) throw new UpstreamError('INVALID_AMOUNT', `${route.symbol} 金额最多 ${route.decimals} 位小数。`, 400);
  const units = parseUnits(amount, route.decimals);
  if (units < parseUnits('10', route.decimals) || units > parseUnits('10000', route.decimals)) throw new UpstreamError('INVALID_AMOUNT', `金额需在 10 至 10,000 ${route.symbol} 之间。`, 400);
  return units;
}

export async function getRoutes(): Promise<Route[]> {
  let config: Chain[];
  try {
    config = await chains();
  } catch { return sourceConfigs.map(({ route }) => ({ ...route, available: false, reason: '无法验证 Relay 当前主网配置，暂时关闭新报价。' })); }
  return Promise.all(sourceConfigs.map(async source => {
    try { validateSourceRegistry(source, config); if (source.route.walletType === 'evm') await assertEvmSourceHealthy(source.route.id); return { ...source.route }; }
    catch { return { ...source.route, available: false, reason: '无法验证该来源链的主网配置，暂时关闭这条路线的新报价。' }; }
  }));
}

function validateSourceRegistry(source: ReturnType<typeof sourceConfig>, config: Chain[]) {
  const origin = config.find(c => c.id === source.route.sourceChainId);
  requireMatch(origin?.protocol?.v2?.chainId === source.protocolChain && origin.protocol.v2.depository && sameSource(source.route, origin.protocol.v2.depository, source.depository) && !origin.disabled && origin.depositEnabled !== false && origin.vmType === (source.route.walletType === 'evm' ? 'evm' : 'tvm'), `不认可的 ${source.route.sourceChain} depository 或网络配置。`);
  requireMatch(config.some(c => c.id === 1337 && c.protocol?.v2?.chainId === 'hyperliquid' && c.vmType === 'hypevm' && !c.disabled), '未找到官方 HyperCore 网络配置。');
}

/** Public for security tests; caller must obtain canonical chains separately from GET /chains. */
export async function validateRelayQuote(raw: unknown, input: QuoteRequest, canonicalChains: Chain[], now = Date.now()): Promise<ProviderQuote> {
  const source = sourceConfig(input.routeId);
  const { route, protocolChain, depository } = source;
  const q = QuoteSchema.parse(raw);
  const sourceHex = route.walletType === 'tron' ? tronHex(input.sourceAddress) : evmAddress(input.sourceAddress);
  const recipient = evmAddress(input.recipient);
  const units = sourceAmount(input.amount, route);
  const p = q.protocol.v2;
  const inputPayment = p.orderData.inputs[0]!.payment;
  const output = p.orderData.output.payments[0]!;
  validateSourceRegistry(source, canonicalChains);
  requireMatch(p.orderData.solverChainId === 'base' && p.orderData.solver.toLowerCase() === SOLVER, '报价使用未经审核的 solver。');
  requireMatch(inputPayment.chainId === protocolChain && sameSource(route, inputPayment.currency, route.sourceToken) && inputPayment.amount === units.toString() && inputPayment.weight === '1', '付款资产或金额不匹配。');
  requireMatch(p.orderData.output.chainId === 'hyperliquid' && output.currency === PERPS_USDC && output.recipient.toLowerCase() === recipient.toLowerCase() && p.orderData.output.extraData === '0x', '目的地必须为指定用户的 HyperCore Perps USDC。');
  requireMatch(p.orderData.output.deadline * 1000 > now + 15_000 && BigInt(output.minimumAmount) > 0n && BigInt(output.minimumAmount) <= BigInt(output.expectedAmount), '报价期限或最小到账额不合法。');
  requireMatch(p.orderData.inputs[0]!.refunds.every(r => (r.chainId === protocolChain && sameSource(route, r.currency, route.sourceToken) && sameSource(route, r.recipient, input.sourceAddress)) || (r.chainId === 'hyperliquid' && r.currency === PERPS_USDC && r.recipient.toLowerCase() === recipient.toLowerCase())), '报价含未知退款目的地。');
  const vms: Record<string, VmType> = {};
  for (const c of canonicalChains) if (c.protocol?.v2?.chainId && VM_TYPES[c.vmType]) vms[c.protocol.v2.chainId] = VM_TYPES[c.vmType]!;
  const computed = getOrderId(p.orderData as Parameters<typeof getOrderId>[0], vms);
  requireMatch(computed.toLowerCase() === p.orderId.toLowerCase(), '协议订单哈希重算不一致。');
  const signer = await recoverMessageAddress({ message: { raw: computed as Hex }, signature: p.orderSignature as Hex });
  requireMatch(signer.toLowerCase() === SOLVER, '协议订单签名不是已核实的 Relay solver。');
  requireMatch(p.paymentDetails.chainId === protocolChain && sameSource(route, p.paymentDetails.depository, depository) && sameSource(route, p.paymentDetails.currency, route.sourceToken) && p.paymentDetails.amount === units.toString(), '协议付款详情不一致。');
  requireMatch(sameSource(route, q.details.sender, input.sourceAddress) && q.details.recipient.toLowerCase() === recipient.toLowerCase(), '报价地址不匹配。');
  requireMatch(q.details.currencyIn.currency.chainId === route.sourceChainId && sameSource(route, q.details.currencyIn.currency.address, route.sourceToken) && q.details.currencyIn.currency.decimals === route.decimals && q.details.currencyIn.amount === units.toString(), '报价输入金额不匹配。');
  requireMatch(q.details.currencyOut.currency.chainId === 1337 && q.details.currencyOut.currency.address === PERPS_USDC && q.details.currencyOut.currency.decimals === 8 && q.details.currencyOut.amount === output.expectedAmount && q.details.currencyOut.minimumAmount === output.minimumAmount, '报价显示金额与协议订单不一致。');
  requireMatch(q.steps.every(s => s.requestId === q.requestId && (s.id === 'approve' || s.id === 'deposit')) && q.steps.filter(s => s.id === 'deposit').length === 1 && q.steps.filter(s => s.id === 'approve').length <= 1, '报价含未知或重复签名步骤。');
  const depositData = q.steps.find(s => s.id === 'deposit')!.items[0]!.data;
  const approval = q.steps.find(s => s.id === 'approve');
  let transaction: WalletTransaction;
  if (route.walletType === 'tron') {
    const deposit = TronIntent.parse(depositData);
    const params = deposit.parameter;
    requireMatch(params.owner_address.toLowerCase() === sourceHex && params.contract_address.toLowerCase() === tronHex(TRON_DEPOSITORY) && (params.call_value ?? 0) === 0 && (params.call_token_value ?? 0) === 0 && params.token_id === undefined, '付款调用的账户或目标合约不合法。');
    const decoded = decodeFunctionData({ abi: parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']), data: `0x${params.data}` });
    requireMatch(decoded.functionName === 'depositErc20' && params.data.length === 8 + 64 * 4 && decoded.args[0].toLowerCase() === `0x${sourceHex.slice(2)}` && decoded.args[1].toLowerCase() === `0x${tronHex(TRON_USDT).slice(2)}` && decoded.args[2] === units && decoded.args[3].toLowerCase() === computed.toLowerCase(), '付款 calldata 未绑定正确的代币、金额、付款人和订单。');
    if (approval) {
      const a = TronIntent.parse(approval.items[0]!.data).parameter;
      const d = decodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount)']), data: `0x${a.data}` });
      requireMatch(a.owner_address.toLowerCase() === sourceHex && a.contract_address.toLowerCase() === tronHex(TRON_USDT) && a.data.length === 8 + 64 * 2 && (a.call_value ?? 0) === 0 && (a.call_token_value ?? 0) === 0 && a.token_id === undefined && d.args[0].toLowerCase() === `0x${tronHex(TRON_DEPOSITORY).slice(2)}` && d.args[1] === units, '授权并非本单的精确 USDT 授权。');
    }
    transaction = { kind: 'tron', transaction: deposit, contractAddress: TRON_DEPOSITORY };
  } else {
    const deposit = EvmIntent.parse(depositData);
    const decoded = decodeFunctionData({ abi: parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']), data: deposit.data as Hex });
    requireMatch(encodeFunctionData({ abi: parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']), functionName: 'depositErc20', args: decoded.args }).toLowerCase() === deposit.data.toLowerCase(), '付款 calldata 并非规范 ABI 编码。');
    requireMatch(deposit.chainId === route.sourceChainId && sameSource(route, deposit.from, input.sourceAddress) && sameSource(route, deposit.to, depository) && BigInt(deposit.value) === 0n && deposit.data.length === 2 + 8 + 64 * 4 && sameSource(route, decoded.args[0], input.sourceAddress) && sameSource(route, decoded.args[1], route.sourceToken) && decoded.args[2] === units && decoded.args[3].toLowerCase() === computed.toLowerCase(), 'EVM 付款 calldata 未绑定正确的链、代币、金额、付款人和订单。');
    if (approval) {
      const a = EvmIntent.parse(approval.items[0]!.data);
      const decodedApproval = decodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount)']), data: a.data as Hex });
      requireMatch(encodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount)']), functionName: 'approve', args: decodedApproval.args }).toLowerCase() === a.data.toLowerCase(), '授权 calldata 并非规范 ABI 编码。');
      requireMatch(a.chainId === route.sourceChainId && sameSource(route, a.from, input.sourceAddress) && sameSource(route, a.to, route.sourceToken) && BigInt(a.value) === 0n && a.data.length === 2 + 8 + 64 * 2 && sameSource(route, decodedApproval.args[0], depository) && decodedApproval.args[1] === units, '授权并非本单的精确 EVM 代币授权。');
    }
    // Only transfer reviewed fields. Fee/nonce/access-list suggestions are not wallet instructions.
    transaction = { kind: 'evm', chainId: route.sourceChainId, to: depository, data: deposit.data, value: '0' };
  }
  const selectedFees = ['gas', 'relayer', 'app'].flatMap(key => { const fee = q.fees[key]; return fee ? [{ label: key === 'gas' ? '源链网络费估算' : key === 'relayer' ? 'Relay 路由费' : '应用费', amount: formatUnits(BigInt(fee.amount), fee.currency.decimals), symbol: fee.currency.symbol }] : []; });
  return {
    routeId: route.id, sourceAddress: input.sourceAddress, recipient, amount: formatUnits(units, route.decimals), amountBaseUnits: units.toString(),
    expectedReceive: formatUnits(BigInt(output.expectedAmount), 8), minReceive: formatUnits(BigInt(output.minimumAmount), 8),
    expiresAt: new Date(Math.min(now + 120_000, p.orderData.output.deadline * 1000)).toISOString(), provider: 'Relay', fees: selectedFees,
    protocolOrderId: computed, ...(route.walletType === 'tron' ? { estimatedSeconds: q.details.timeEstimate } : {}), transaction,
    ...(approval || route.walletType === 'evm' ? { approval: { token: route.sourceToken, spender: depository, amount: units.toString() } } : {}),
    warnings: [route.walletType === 'tron' ? '需要 TRX 支付授权和付款的带宽/能量成本，实际网络费以钱包为准。' : `需要 ${route.sourceChain} 主网 ${route.gasSymbol} 支付授权和付款手续费，实际费用以钱包为准。${reviewedEvmSource(route.id)!.finalityWarning}`, ...(route.assetNote ? [route.assetNote] : []), '路由使用 Relay 协议及流动性服务；可能发生延迟或退款，失败不代表立即退款。', '这是主网真实资金交易，请确认你能够控制 Hyperliquid 收款地址。', '退款可能在源链或 HyperCore 处理，具体以协议状态和可验证记录为准。'],
    providerData: { requestId: q.requestId, orderId: computed, quotedAt: now, deadline: p.orderData.output.deadline, expectedAmount: output.expectedAmount, minimumAmount: output.minimumAmount },
  };
}

export async function getQuote(input: QuoteRequest): Promise<ProviderQuote> {
  const source = sourceConfig(input.routeId);
  const { route } = source;
  if (route.walletType === 'tron') tronHex(input.sourceAddress); else evmAddress(input.sourceAddress);
  evmAddress(input.recipient);
  const amount = sourceAmount(input.amount, route).toString();
  const canonicalChains = await chains();
  validateSourceRegistry(source, canonicalChains);
  if (route.walletType === 'evm') await assertEvmSourceHealthy(route.id);
  const raw = await postJson(`${API}/quote/v2`, { user: input.sourceAddress, recipient: input.recipient, originChainId: route.sourceChainId, destinationChainId: 1337, originCurrency: route.sourceToken, destinationCurrency: PERPS_USDC, amount, tradeType: 'EXACT_INPUT', protocolVersion: 'v2', includeProtocolData: true, explicitDeposit: true, useDepositAddress: false, refundTo: input.sourceAddress, slippageTolerance: '100' }, headers());
  return validateRelayQuote(raw, input, canonicalChains);
}

export async function verifySourceTransaction(quote: StoredQuote, txHash: string) {
  const { route } = sourceConfig(quote.routeId);
  return route.walletType === 'tron' ? verifyTronSource(quote, txHash) : route.sourceChainId === 1 ? verifyEthereumSource(quote, txHash) : verifyEvmSource(quote, txHash);
}
const StatusSchema = z.object({ status: z.enum(['waiting','depositing','pending','submitted','success','delayed','refund','failure']), inTxHashes: z.array(z.string()).optional(), txHashes: z.array(z.string()).optional(), originChainId: z.number().optional(), destinationChainId: z.number().optional(), updatedAt: z.number().optional() });
export async function trackOrder(order: TrackedOrder): Promise<TrackingUpdate> {
  const { route } = sourceConfig(order.quote.routeId);
  if (!order.sourceTxHash) return { status: 'awaiting_signature', statusMessage: '等待用户在钱包签署付款交易。' };
  const verified = await verifySourceTransaction({ ...order.quote, providerData: order.providerData }, order.sourceTxHash);
  if (!verified.valid) return { status: 'attention', statusMessage: verified.reason ?? '源交易核验未通过，请检查交易。' };
  if (verified.pending) return { status: 'source_pending', statusMessage: route.walletType === 'evm' ? `已保存交易哈希。${reviewedEvmSource(route.id)!.finalityWarning}` : '已保存交易哈希，等待 Tron 固化确认。' };
  const requestId = hex32.parse(order.providerData.requestId);
  const status = StatusSchema.parse(await fetchJson(`${API}/intents/status/v3?requestId=${requestId}`, { headers: headers() }));
  if (status.inTxHashes?.length && !status.inTxHashes.some(h => h.replace(/^0x/, '').toLowerCase() === order.sourceTxHash!.replace(/^0x/, '').toLowerCase())) return { status: 'attention', statusMessage: 'Relay 记录的源交易与订单不匹配，需人工核查。' };
  if (status.originChainId !== undefined && status.originChainId !== route.sourceChainId || status.destinationChainId !== undefined && status.destinationChainId !== 1337) return { status: 'attention', statusMessage: 'Relay 记录的源链或目标链不匹配。' };
  if (status.status === 'refund' || status.status === 'failure') return { status: 'attention', statusMessage: status.status === 'refund' ? 'Relay 报告已退款；请核对钱包和退款链上记录。本系统未将其认定为充值成功。' : 'Relay 报告执行异常，源资金已转出，请依据原订单查询恢复或退款进度。', providerOrderId: requestId };
  if (status.status !== 'success') return { status: 'bridging', statusMessage: status.status === 'delayed' ? '源交易已固化，Relay 执行延迟；仍在追踪。' : '源交易已固化，等待 Relay 完成兑换和 HyperCore 转入。', providerOrderId: requestId };
  const fillHashes = (status.txHashes ?? []).filter(h => /^0x[0-9a-fA-F]{64}$/.test(h));
  if (!status.inTxHashes?.some(h => h.replace(/^0x/, '').toLowerCase() === order.sourceTxHash!.replace(/^0x/, '').toLowerCase()) || fillHashes.length === 0) return { status: 'verifying_credit', statusMessage: 'Relay 报告完成，等待可归属于本单的源交易和目标交易证据。', providerOrderId: requestId };
  const quotedAt = z.number().int().parse(order.providerData.quotedAt);
  // updatedAt is the provider record's update time, not the fill time. Recover
  // from the original quote boundary with a server-persisted bounded cursor.
  const earliest = Math.max(0, quotedAt - 60_000);
  const endTime = Date.now();
  const fillHashesKey = [...new Set(fillHashes.map(hash => hash.toLowerCase()))].sort().join(',');
  const saved = z.object({ startTime: z.number().int().min(earliest).max(endTime), fillHashesKey: z.literal(fillHashesKey) }).safeParse(order.providerData.creditScan);
  const { credit, nextStartTime } = await scanPerpsCredit(order.quote.recipient, fillHashes, order.quote.minReceive, earliest, endTime, saved.success ? saved.data.startTime : earliest);
  if (!credit) return { status: 'verifying_credit', statusMessage: 'Relay 报告完成，尚未匹配到指定用户默认 Perps USDC 账本入账；继续核验。', providerOrderId: requestId, destinationTxHash: fillHashes[0], providerDataPatch: { creditScan: { startTime: nextStartTime, fillHashesKey } } };
  return { status: 'completed', statusMessage: `已匹配 ${route.sourceChain} 最终确认付款、Relay 订单与 HyperCore 默认 Perps USDC 入账。`, providerOrderId: requestId, destinationTxHash: credit.hash, creditedAmount: credit.amount, evidence: [{ type: `${sourceConfig(order.quote.routeId).protocolChain}_finalized_transfer`, reference: order.sourceTxHash }, { type: 'relay_request', reference: requestId }, { type: 'hypercore_credit', reference: `${order.quote.recipient}:${credit.hash}` }] };
}
export { getAccount };
