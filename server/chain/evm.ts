import { z } from 'zod';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseUnits, type Hex } from 'viem';
import type { SourceVerification, StoredQuote } from '../../shared/types.js';
import { evmRpcFailover } from './evm-rpc.js';
import { reviewedEvmSource } from '../../shared/route-registry.js';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const data = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);
const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const depositAbi = parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']);
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const Transaction = z.object({ hash, from: address, to: address.nullable(), input: data, value: quantity, chainId: quantity.optional(), blockHash: hash.nullable(), blockNumber: quantity.nullable() });
const Log = z.object({ address, topics: z.array(hash), data, transactionHash: hash, blockHash: hash, blockNumber: quantity, removed: z.boolean().optional() });
const Receipt = z.object({ transactionHash: hash, from: address, to: address.nullable(), blockHash: hash, blockNumber: quantity, status: quantity, logs: z.array(Log) });
const Block = z.object({ hash, number: quantity, transactions: z.array(hash) });

/** A finalized receipt is necessary but insufficient: bind both the call and transfer to this order. */
export async function verifyEvmSource(quote: StoredQuote, txHash: string): Promise<SourceVerification> {
  const source = reviewedEvmSource(quote.routeId);
  if (!source) return { valid: false, reason: '未审核的 EVM 来源路线。' };
  const { route, depository, finalityWarning } = source;
  const chain = route.sourceChain;
  if (!hash.safeParse(txHash).success) return { valid: false, reason: `${chain} 交易哈希格式不正确。` };
  if (quote.transaction.kind !== 'evm' || quote.transaction.chainId !== route.sourceChainId || !same(quote.transaction.to, depository) || quote.transaction.value !== '0' || !hash.safeParse(quote.protocolOrderId).success || !same(quote.protocolOrderId!, String(quote.providerData.orderId))) return { valid: false, reason: `${chain} 订单网络、合约或协议标识不匹配。` };
  const expected = quote.transaction;
  try {
    if (!/^\d+(?:\.\d+)?$/.test(quote.amount) || (quote.amount.split('.')[1]?.length ?? 0) > route.decimals || parseUnits(quote.amount, route.decimals) !== BigInt(quote.amountBaseUnits)) return { valid: false, reason: `${chain} 显示金额与链上付款数量不一致。` };
    const call = decodeFunctionData({ abi: depositAbi, data: expected.data as Hex });
    if (!same(encodeFunctionData({ abi: depositAbi, functionName: 'depositErc20', args: call.args }), expected.data)) return { valid: false, reason: `${chain} 付款调用并非规范 ABI 编码。` };
    if (expected.data.length !== 2 + 8 + 64 * 4 || !same(call.args[0], quote.sourceAddress) || !same(call.args[1], route.sourceToken) || call.args[2] !== BigInt(quote.amountBaseUnits) || !same(call.args[3], quote.protocolOrderId!)) return { valid: false, reason: `${chain} 报价付款调用未绑定本单。` };
  } catch { return { valid: false, reason: `${chain} 报价付款调用无效。` }; }
  const [chainId, rawTx, rawReceipt] = await Promise.all([
    evmRpcFailover(quote.routeId, 'eth_chainId', []), evmRpcFailover(quote.routeId, 'eth_getTransactionByHash', [txHash]), evmRpcFailover(quote.routeId, 'eth_getTransactionReceipt', [txHash]),
  ]);
  if (BigInt(quantity.parse(chainId)) !== BigInt(route.sourceChainId)) return { valid: false, reason: `RPC 返回的来源网络不是 ${chain} 主网。` };
  if (rawTx === null) return { valid: true, pending: true, reason: `等待 ${chain} 节点检索付款交易。` };
  const tx = Transaction.parse(rawTx);
  if (!same(tx.hash, txHash) || !same(tx.from, quote.sourceAddress) || !tx.to || !same(tx.to, expected.to) || !same(tx.input, expected.data) || BigInt(tx.value) !== 0n || (tx.chainId !== undefined && BigInt(tx.chainId) !== BigInt(route.sourceChainId))) return { valid: false, reason: `${chain} 链上付款人、合约、金额或订单标识与报价不匹配。` };
  if (rawReceipt === null || tx.blockHash === null || tx.blockNumber === null) return { valid: true, pending: true, reason: `等待 ${chain} 交易被区块收录。` };
  const receipt = Receipt.parse(rawReceipt);
  if (!same(receipt.transactionHash, txHash) || !same(receipt.from, quote.sourceAddress) || !receipt.to || !same(receipt.to, expected.to) || !same(receipt.blockHash, tx.blockHash) || BigInt(receipt.blockNumber) !== BigInt(tx.blockNumber) || BigInt(receipt.status) !== 1n) return { valid: false, reason: `${chain} 执行回执不匹配或付款执行失败。` };
  const fromTopic = `0x${quote.sourceAddress.slice(2).toLowerCase().padStart(64, '0')}`;
  const toTopic = `0x${depository.slice(2).padStart(64, '0')}`;
  const transfer = receipt.logs.some(log => !log.removed && same(log.address, route.sourceToken) && log.topics.length === 3 && same(log.topics[0]!, transferTopic) && same(log.topics[1]!, fromTopic) && same(log.topics[2]!, toTopic) && hash.safeParse(log.data).success && BigInt(log.data) === BigInt(quote.amountBaseUnits) && same(log.transactionHash, txHash) && same(log.blockHash, receipt.blockHash) && BigInt(log.blockNumber) === BigInt(receipt.blockNumber));
  if (!transfer) return { valid: false, reason: `未找到与本单完全匹配的 ${chain} ${route.symbol} 转账事件。` };
  const [rawFinalized, rawCanonical] = await Promise.all([
    evmRpcFailover(quote.routeId, 'eth_getBlockByNumber', ['finalized', false]), evmRpcFailover(quote.routeId, 'eth_getBlockByNumber', [receipt.blockNumber, false]),
  ]);
  if (rawFinalized === null || rawCanonical === null) return { valid: true, pending: true, reason: `等待 ${chain} canonical 区块与最终确认信息。` };
  const finalized = Block.parse(rawFinalized);
  const canonical = Block.parse(rawCanonical);
  if (BigInt(canonical.number) !== BigInt(receipt.blockNumber) || !same(canonical.hash, receipt.blockHash) || !canonical.transactions.some(h => same(h, txHash))) return { valid: false, reason: `${chain} 回执不在当前 canonical 区块中，需等待重组核查。` };
  if (BigInt(finalized.number) < BigInt(receipt.blockNumber)) return { valid: true, pending: true, reason: finalityWarning };
  if (BigInt(finalized.number) === BigInt(receipt.blockNumber) && !same(finalized.hash, canonical.hash)) return { valid: false, reason: `${chain} 最终确认区块与交易区块不一致。` };
  return { valid: true, pending: false, providerOrderId: String(quote.providerData.requestId) };
}
