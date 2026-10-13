import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { StoredQuote, SourceVerification } from '../../shared/types.js';
import { postJson, UpstreamError } from './http.js';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const sha256 = (input: Uint8Array) => createHash('sha256').update(input).digest();
export function tronHex(address: string): string {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) throw new UpstreamError('INVALID_ADDRESS', '无效的 Tron 主网地址。', 400);
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
  const bytes = Buffer.from(value.toString(16).padStart(50, '0'), 'hex');
  if (bytes.length !== 25 || bytes[0] !== 0x41 || !timingSafeEqual(bytes.subarray(21), sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4))) {
    throw new UpstreamError('INVALID_ADDRESS', 'Tron 地址校验和不正确。', 400);
  }
  return bytes.subarray(0, 21).toString('hex');
}
export const TronParameter = z.object({ owner_address: z.string().regex(/^41[0-9a-fA-F]{40}$/), contract_address: z.string().regex(/^41[0-9a-fA-F]{40}$/), data: z.string().regex(/^[0-9a-fA-F]+$/), call_value: z.number().int().nonnegative().optional(), call_token_value: z.number().int().nonnegative().optional(), token_id: z.number().int().optional() });
export const TronIntent = z.object({ type: z.literal('TriggerSmartContract'), parameter: TronParameter });
export type TronIntentData = z.infer<typeof TronIntent>;
const transferTopic = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export async function verifyTronSource(quote: StoredQuote, txHash: string): Promise<SourceVerification> {
  if (!/^[a-fA-F0-9]{64}$/.test(txHash)) return { valid: false, reason: 'Tron 交易哈希格式不正确。' };
  const headers: Record<string, string> = process.env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRONGRID_API_KEY } : {};
  const [rawTx, rawReceipt] = await Promise.all([
    postJson('https://api.trongrid.io/walletsolidity/gettransactionbyid', { value: txHash }, headers),
    postJson('https://api.trongrid.io/walletsolidity/gettransactioninfobyid', { value: txHash }, headers),
  ]);
  const txSchema = z.object({ txID: z.string(), raw_data_hex: z.string(), raw_data: z.object({ contract: z.array(z.object({ type: z.string(), parameter: z.object({ value: TronParameter }) })) }), ret: z.array(z.object({ contractRet: z.string() })).optional() });
  // SolidityNode returns {} until finality. HTTP errors are not represented as pending.
  if (Object.keys(z.record(z.string(), z.unknown()).parse(rawTx)).length === 0) return { valid: true, pending: true, reason: '等待 Tron 固化确认。' };
  const tx = txSchema.parse(rawTx);
  if (tx.txID.toLowerCase() !== txHash.toLowerCase() || sha256(Buffer.from(tx.raw_data_hex, 'hex')).toString('hex') !== txHash.toLowerCase()) return { valid: false, reason: '链上交易标识不匹配。' };
  if (quote.transaction.kind !== 'tron') return { valid: false, reason: '订单网络不匹配。' };
  const expected = TronIntent.parse(quote.transaction.transaction);
  const contract = tx.raw_data.contract[0];
  if (tx.raw_data.contract.length !== 1 || !contract || contract.type !== 'TriggerSmartContract') return { valid: false, reason: '交易不是唯一的已批准合约调用。' };
  const actual = contract.parameter.value;
  if (actual.owner_address.toLowerCase() !== expected.parameter.owner_address.toLowerCase() || actual.contract_address.toLowerCase() !== expected.parameter.contract_address.toLowerCase() || actual.data.toLowerCase() !== expected.parameter.data.toLowerCase() || (actual.call_value ?? 0) !== 0 || (actual.call_token_value ?? 0) !== 0 || actual.token_id !== undefined) return { valid: false, reason: '链上付款人、合约、金额或订单标识与报价不匹配。' };
  if (Object.keys(z.record(z.string(), z.unknown()).parse(rawReceipt)).length === 0) return { valid: true, pending: true, reason: '等待 Tron 固化执行结果。' };
  const receipt = z.object({ id: z.string(), receipt: z.object({ result: z.string().optional() }), log: z.array(z.object({ address: z.string(), topics: z.array(z.string()), data: z.string() })).optional() }).parse(rawReceipt);
  if (receipt.id.toLowerCase() !== txHash.toLowerCase() || receipt.receipt.result !== 'SUCCESS' || tx.ret?.some(x => x.contractRet !== 'SUCCESS')) return { valid: false, reason: 'Tron 固化交易执行未成功。' };
  const tokenHex = tronHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').slice(2);
  const from = tronHex(quote.sourceAddress).slice(2).padStart(64, '0');
  const to = expected.parameter.contract_address.slice(2).padStart(64, '0');
  const transfer = receipt.log?.some(log => log.address.toLowerCase() === tokenHex && log.topics.length === 3 && log.topics[0]?.toLowerCase() === transferTopic && log.topics[1]?.toLowerCase() === from && log.topics[2]?.toLowerCase() === to && /^[0-9a-fA-F]{64}$/.test(log.data) && BigInt(`0x${log.data}`) === BigInt(quote.amountBaseUnits));
  if (!transfer) return { valid: false, reason: '未找到与报价完全匹配的 USDT 转账事件。' };
  return { valid: true, pending: false, providerOrderId: String(quote.providerData.requestId) };
}
