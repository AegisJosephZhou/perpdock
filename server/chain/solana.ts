import bs58 from 'bs58';
import { z } from 'zod';
import type { SourceVerification, StoredQuote } from '../../shared/types.js';
import {
  deriveSolanaDepositAccounts, SOLANA_CHAIN_ID, SOLANA_DEPOSITORY, SOLANA_GENESIS_HASH,
  SOLANA_ROUTE_ID, SOLANA_RPC_URL, SOLANA_TOKEN_PROGRAM, SOLANA_USDC,
  solanaAddress, solanaSignature, validateSolanaInstructions,
} from '../../shared/solana.js';
import { postJson, UpstreamError } from './http.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const address = z.string().refine(value => { try { solanaAddress(value); return true; } catch { return false; } });
const errorValue = z.union([z.null(), z.string(), z.record(z.string(), z.unknown())]);
const units = z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= 0xffffffffffffffffn);
const compiledInstruction = z.object({ programIdIndex: integer, accounts: z.array(integer), data: z.string(), stackHeight: integer.nullable().optional() });
const tokenBalance = z.object({ accountIndex: integer, mint: address, owner: address, programId: address.optional(), uiTokenAmount: z.object({ amount: units, decimals: integer.max(255) }) });
const transactionResult = z.object({
  slot: integer, version: z.union([z.literal('legacy'), z.literal(0)]).optional(),
  transaction: z.object({ signatures: z.array(z.string()).length(1), message: z.object({
    accountKeys: z.array(address).min(1).max(256), recentBlockhash: address,
    header: z.object({ numRequiredSignatures: z.literal(1), numReadonlySignedAccounts: z.literal(0), numReadonlyUnsignedAccounts: integer }),
    instructions: z.array(compiledInstruction).length(1),
    addressTableLookups: z.array(z.unknown()).max(0).optional(),
  }) }),
  meta: z.object({
    err: errorValue, fee: integer, preBalances: z.array(integer), postBalances: z.array(integer),
    preTokenBalances: z.array(tokenBalance), postTokenBalances: z.array(tokenBalance),
    loadedAddresses: z.object({ writable: z.array(address).max(0), readonly: z.array(address).max(0) }).optional(),
    innerInstructions: z.array(z.object({ index: z.literal(0), instructions: z.array(compiledInstruction) })).max(1),
  }).nullable(),
});
const signatureStatuses = z.object({ context: z.object({ slot: integer }), value: z.array(z.object({ slot: integer, confirmations: integer.nullable(), err: errorValue, confirmationStatus: z.enum(['processed', 'confirmed', 'finalized']) }).nullable()).length(1) });

/** Operator configuration only. Never accept an RPC URL from a visitor or expose it in errors. */
export function solanaRpcUrl(): string {
  try {
    const url = new URL(process.env.SOLANA_RPC_URL || SOLANA_RPC_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { throw new UpstreamError('SOLANA_RPC_CONFIG', 'Solana RPC 必须使用无 URL 凭据或片段的 HTTPS 地址。', 503); }
}

export async function solanaRpc(method: string, params: unknown[], timeoutMs?: number): Promise<unknown> {
  // Keep schema errors and upstream RPC error payloads private: providers may echo secret query keys.
  try {
    const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.literal(1), result: z.unknown().optional(), error: z.unknown().optional() }).parse(await postJson(solanaRpcUrl(), { jsonrpc: '2.0', id: 1, method, params }, {}, timeoutMs));
    if (Object.hasOwn(envelope, 'error') || !Object.hasOwn(envelope, 'result') || envelope.result === undefined) throw new Error();
    return envelope.result;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('SOLANA_RPC_ERROR', 'Solana RPC 尚未提供可靠结果，交易状态未改变。', 503);
  }
}

let healthProbe: { url: string; expiresAt: number; result: Promise<void> } | undefined;
/** Fail closed for new quotes. Tracking old orders does not depend on this cache. */
export function assertSolanaSourceHealthy(): Promise<void> {
  const url = solanaRpcUrl();
  if (healthProbe?.url === url && healthProbe.expiresAt > Date.now()) return healthProbe.result;
  const probe = { url, expiresAt: Infinity, result: Promise.resolve() };
  probe.result = Promise.resolve().then(async () => {
    const [genesis, slot, rawProgram, rawMint] = await Promise.all([
      solanaRpc('getGenesisHash', [], 5_000), solanaRpc('getSlot', [{ commitment: 'finalized' }], 5_000),
      solanaRpc('getAccountInfo', [SOLANA_DEPOSITORY, { commitment: 'finalized', encoding: 'base64' }], 5_000),
      solanaRpc('getAccountInfo', [SOLANA_USDC, { commitment: 'finalized', encoding: 'jsonParsed' }], 5_000),
    ]);
    if (genesis !== SOLANA_GENESIS_HASH) throw new UpstreamError('SOLANA_NETWORK_MISMATCH', 'Solana RPC 网络与审核配置不一致。', 503);
    try {
      integer.parse(slot);
      z.object({ context: z.object({ slot: integer }), value: z.object({ executable: z.literal(true), owner: z.literal('BPFLoaderUpgradeab1e11111111111111111111111') }) }).parse(rawProgram);
      z.object({ context: z.object({ slot: integer }), value: z.object({ executable: z.literal(false), owner: z.literal(SOLANA_TOKEN_PROGRAM), data: z.object({ program: z.literal('spl-token'), parsed: z.object({ type: z.literal('mint'), info: z.object({ decimals: z.literal(6), isInitialized: z.literal(true) }) }) }) }) }).parse(rawMint);
    } catch { throw new UpstreamError('SOLANA_ACCOUNT_MISMATCH', 'Solana 程序或 USDC 代币配置与审核结果不一致。', 503); }
  }).then(() => { probe.expiresAt = Date.now() + 60_000; }, error => { probe.expiresAt = Date.now() + 15_000; throw error; });
  healthProbe = probe;
  return probe.result;
}

function decodedInstructionData(data: string): Buffer {
  if (!/^[1-9A-HJ-NP-Za-km-z]*$/.test(data) || data.length > 512) throw new Error('Invalid instruction data');
  const decoded = bs58.decode(data);
  if (bs58.encode(decoded) !== data) throw new Error('Noncanonical instruction data');
  return Buffer.from(decoded);
}

/** Only the single checked USDC transfer and, if needed, creation of its vault ATA are allowed. */
function verifyInnerInstructions(result: z.infer<typeof transactionResult>, source: string, amount: bigint, createsVault: boolean, rent: bigint): boolean {
  if (!result.meta) return false;
  const accounts = deriveSolanaDepositAccounts(source);
  const keys = result.transaction.message.accountKeys;
  const instructions = result.meta.innerInstructions[0]?.instructions ?? [];
  let transfers = 0;
  let creates = 0;
  let associatedCreates = 0;
  for (const instruction of instructions) {
    const program = keys[instruction.programIdIndex];
    const addresses = instruction.accounts.map(index => keys[index]);
    if (addresses.some(value => value === undefined)) return false;
    const data = decodedInstructionData(instruction.data);
    const equals = (expected: string[]) => addresses.length === expected.length && addresses.every((value, index) => value === expected[index]);
    if (program === accounts.tokenProgram) {
      if (data[0] === 3 && data.length === 9 && equals([accounts.senderTokenAccount, accounts.vaultTokenAccount, source]) && data.readBigUInt64LE(1) === amount) transfers++;
      else if (data[0] === 12 && data.length === 10 && data[9] === 6 && equals([accounts.senderTokenAccount, accounts.mint, accounts.vaultTokenAccount, source]) && data.readBigUInt64LE(1) === amount) transfers++;
      else if (createsVault && data[0] === 21 && data.length === 1 && equals([accounts.mint])) { /* GetAccountDataSize */ }
      else if (createsVault && data[0] === 22 && data.length === 1 && equals([accounts.vaultTokenAccount])) { /* InitializeImmutableOwner */ }
      else if (createsVault && data[0] === 18 && data.length === 33 && equals([accounts.vaultTokenAccount, accounts.mint]) && bs58.encode(data.subarray(1)) === accounts.vault) { /* InitializeAccount3 */ }
      else return false;
    } else if (program === accounts.associatedTokenProgram) {
      if (!createsVault || !equals([source, accounts.vaultTokenAccount, accounts.vault, accounts.mint, accounts.systemProgram, accounts.tokenProgram]) || !(data.length === 0 || (data.length === 1 && (data[0] === 0 || data[0] === 1)))) return false;
      associatedCreates++;
    } else if (program === accounts.systemProgram) {
      if (!createsVault || data.length !== 52 || data.readUInt32LE(0) !== 0 || !equals([source, accounts.vaultTokenAccount]) || data.readBigUInt64LE(4) !== rent || data.readBigUInt64LE(12) !== 165n || bs58.encode(data.subarray(20)) !== accounts.tokenProgram) return false;
      creates++;
    } else return false;
  }
  return transfers === 1 && creates === (createsVault ? 1 : 0) && associatedCreates === (createsVault ? 1 : 0);
}

function verifiedBalances(result: z.infer<typeof transactionResult>, source: string, amount: bigint): boolean {
  const meta = result.meta!;
  const keys = result.transaction.message.accountKeys;
  const accounts = deriveSolanaDepositAccounts(source);
  const senderIndex = keys.indexOf(accounts.senderTokenAccount);
  const vaultIndex = keys.indexOf(accounts.vaultTokenAccount);
  const pre = new Map(meta.preTokenBalances.map(balance => [balance.accountIndex, balance]));
  const post = new Map(meta.postTokenBalances.map(balance => [balance.accountIndex, balance]));
  if (pre.size !== meta.preTokenBalances.length || post.size !== meta.postTokenBalances.length || senderIndex < 0 || vaultIndex < 0 || meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length) return false;
  const correct = (balance: z.infer<typeof tokenBalance> | undefined, owner: string) => balance && balance.mint === SOLANA_USDC && balance.owner === owner && balance.uiTokenAmount.decimals === 6 && (balance.programId === undefined || balance.programId === SOLANA_TOKEN_PROGRAM);
  const senderBefore = pre.get(senderIndex), senderAfter = post.get(senderIndex);
  const vaultBefore = pre.get(vaultIndex), vaultAfter = post.get(vaultIndex);
  if (!correct(senderBefore, source) || !correct(senderAfter, source) || !correct(vaultAfter, accounts.vault) || (vaultBefore && !correct(vaultBefore, accounts.vault))) return false;
  if (BigInt(senderBefore!.uiTokenAmount.amount) - BigInt(senderAfter!.uiTokenAmount.amount) !== amount || BigInt(vaultAfter!.uiTokenAmount.amount) - BigInt(vaultBefore?.uiTokenAmount.amount ?? '0') !== amount) return false;
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    if (index >= keys.length) return false;
    if (index === senderIndex || index === vaultIndex) continue;
    const before = pre.get(index), after = post.get(index);
    if (!before || !after || before.mint !== after.mint || before.owner !== after.owner || before.programId !== after.programId || before.uiTokenAmount.decimals !== after.uiTokenAmount.decimals || before.uiTokenAmount.amount !== after.uiTokenAmount.amount) return false;
  }
  const createsVault = !vaultBefore;
  const rent = BigInt(meta.postBalances[vaultIndex]!) - BigInt(meta.preBalances[vaultIndex]!);
  if (createsVault ? meta.preBalances[vaultIndex] !== 0 || rent <= 0n : rent !== 0n) return false;
  if (BigInt(meta.preBalances[0]!) - BigInt(meta.postBalances[0]!) !== BigInt(meta.fee) + rent) return false;
  if (keys.some((_, index) => index !== 0 && index !== vaultIndex && meta.preBalances[index] !== meta.postBalances[index])) return false;
  return verifyInnerInstructions(result, source, amount, createsVault, rent);
}

/** Finalized source proof is necessary but does not itself prove destination credit. */
export async function verifySolanaSource(quote: StoredQuote, txHash: string): Promise<SourceVerification> {
  try { solanaSignature(txHash); } catch { return { valid: false, reason: 'Solana 交易签名格式不正确。' }; }
  if (quote.routeId !== SOLANA_ROUTE_ID || quote.transaction.kind !== 'solana' || quote.transaction.chainId !== SOLANA_CHAIN_ID || !quote.protocolOrderId || quote.protocolOrderId.toLowerCase() !== String(quote.providerData.orderId).toLowerCase() || typeof quote.providerData.requestId !== 'string' || !quote.providerData.requestId) return { valid: false, reason: 'Solana 订单网络或协议标识不匹配。' };
  let expected;
  try {
    const parts = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(quote.amount);
    if (!parts || BigInt(parts[1]!) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(6, '0') || '0') !== BigInt(quote.amountBaseUnits)) throw new Error();
    expected = validateSolanaInstructions(quote.transaction.instructions, quote.sourceAddress, quote.amountBaseUnits, quote.protocolOrderId);
  } catch { return { valid: false, reason: 'Solana 报价付款调用未绑定本单。' }; }
  const [genesis, rawTransaction, rawStatuses] = await Promise.all([
    solanaRpc('getGenesisHash', []),
    solanaRpc('getTransaction', [txHash, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]),
    solanaRpc('getSignatureStatuses', [[txHash], { searchTransactionHistory: true }]),
  ]);
  if (genesis !== SOLANA_GENESIS_HASH) return { valid: false, reason: 'RPC 返回的来源网络不是 Solana 主网。' };
  let statuses: z.infer<typeof signatureStatuses>;
  try { statuses = signatureStatuses.parse(rawStatuses); }
  catch { throw new UpstreamError('SOLANA_RPC_ERROR', 'Solana RPC 交易状态格式不可靠，交易状态未改变。', 503); }
  const status = statuses.value[0];
  if (status?.err !== undefined && status.err !== null) return { valid: false, reason: 'Solana 付款执行失败。' };
  if (rawTransaction === null) return { valid: true, pending: true, reason: '等待 Solana 节点检索最终确认的付款交易。' };
  let result: z.infer<typeof transactionResult>;
  try { result = transactionResult.parse(rawTransaction); }
  catch { throw new UpstreamError('SOLANA_RPC_ERROR', 'Solana RPC 付款记录格式不可靠，交易状态未改变。', 503); }
  if (!result.meta) return { valid: true, pending: true, reason: '等待 Solana 完整执行结果。' };
  if (result.meta.err !== null) return { valid: false, reason: 'Solana 付款执行失败。' };
  if (status && (status.slot !== result.slot || statuses.context.slot < result.slot)) return { valid: false, reason: 'Solana 最终确认状态与交易区块不一致。' };
  const message = result.transaction.message;
  try {
    const keys = message.accountKeys;
    const writable = new Set([quote.sourceAddress, ...expected.flatMap(instruction => instruction.keys.filter(key => key.isWritable).map(key => key.pubkey))]);
    const expectedKeys = new Set(expected.flatMap(instruction => [instruction.programId, ...instruction.keys.map(key => key.pubkey)]));
    if (result.transaction.signatures[0] !== txHash || keys[0] !== quote.sourceAddress || new Set(keys).size !== keys.length || keys.length !== expectedKeys.size || keys.some(key => !expectedKeys.has(key)) || message.header.numReadonlyUnsignedAccounts > keys.length - 1) throw new Error();
    if (keys.some((key, index) => (index < keys.length - message.header.numReadonlyUnsignedAccounts) !== writable.has(key))) throw new Error();
    const actual = message.instructions[0]!;
    const desired = expected[0]!;
    if (keys[actual.programIdIndex] !== desired.programId || actual.accounts.length !== desired.keys.length || actual.accounts.some((index, offset) => keys[index] !== desired.keys[offset]!.pubkey) || decodedInstructionData(actual.data).toString('hex') !== desired.data) throw new Error();
    if (!verifiedBalances(result, quote.sourceAddress, BigInt(quote.amountBaseUnits))) throw new Error();
  } catch { return { valid: false, reason: 'Solana 链上付款人、指令、资产变动或订单标识与报价不匹配。' }; }
  if (!status || status.confirmationStatus !== 'finalized' || status.confirmations !== null) return { valid: true, pending: true, reason: '等待 Solana 最终确认。' };
  return { valid: true, pending: false, providerOrderId: quote.providerData.requestId };
}
