import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Connection, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, type BlockhashWithExpiryBlockHeight } from '@solana/web3.js';
import { formatUnits, parseUnits } from 'viem';
import type { Quote, Route } from '../shared/types.js';
import { SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CHAIN_ID, SOLANA_GENESIS_HASH, SOLANA_ROUTE_ID, SOLANA_TOKEN_PROGRAM, SOLANA_USDC, SOLANA_RPC_URL, solanaAddress, solanaPayerAddress, validateSolanaInstructions } from '../shared/solana.js';

interface SolanaPublicKey { toBase58(): string }
export interface SolanaProvider {
  isPhantom?: boolean; isSolflare?: boolean; publicKey?: SolanaPublicKey | null; isConnected?: boolean;
  connect: () => Promise<{ publicKey?: SolanaPublicKey } | void>;
  disconnect?: () => Promise<void>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}
declare global { interface Window { phantom?: { solana?: SolanaProvider }; solana?: SolanaProvider; solflare?: SolanaProvider } }
interface Session { provider?: SolanaProvider; name?: string; version: number; disconnected?: boolean; detached?: () => void }
const sessions = new WeakMap<Window, Session>();
function session(): Session {
  let value = sessions.get(window);
  if (!value) { value = { version: 0 }; sessions.set(window, value); }
  return value;
}
function discovered(): { id: string; name: string; provider: SolanaProvider }[] {
  const phantom = window.phantom?.solana || window.solana;
  const values = [
    ...(phantom?.isPhantom ? [{ id: 'phantom', name: 'Phantom', provider: phantom }] : []),
    ...(window.solflare?.isSolflare ? [{ id: 'solflare', name: 'Solflare', provider: window.solflare }] : []),
  ];
  return values.filter(value => typeof value.provider.connect === 'function' && typeof value.provider.signTransaction === 'function');
}
export function listSolanaWallets(): { id: string; name: string }[] { return discovered().map(({ id, name }) => ({ id, name })); }
export function solanaProvider(): SolanaProvider {
  const provider = session().provider;
  if (!provider || session().disconnected) throw new Error('请先连接并解锁 Phantom 或 Solflare 浏览器钱包。');
  return provider;
}
export function selectedSolanaWalletName(): string | undefined { return session().name; }
export function currentSolanaAddress(): string {
  try { return solanaAddress(solanaProvider().publicKey?.toBase58() || ''); } catch { return ''; }
}
export async function connectSolana(walletId?: string): Promise<string> {
  const state = session(); const version = ++state.version;
  const wallet = walletId ? discovered().find(value => value.id === walletId) : discovered()[0];
  if (!wallet) throw new Error('未检测到所选 Solana 钱包。请安装并解锁 Phantom 或 Solflare 浏览器扩展。');
  await wallet.provider.connect();
  if (version !== state.version) throw new Error('Solana 钱包连接请求已取消，请重新连接。');
  let address: string;
  try { address = solanaPayerAddress(wallet.provider.publicKey?.toBase58() || ''); } catch { throw new Error('Solana 钱包未返回有效的付款账户。'); }
  state.detached?.(); state.provider = wallet.provider; state.name = wallet.name; state.disconnected = false;
  // Pin the provider and invalidate work even if an account changes away and back.
  const changed = () => { state.version++; };
  const disconnected = () => { changed(); state.disconnected = true; };
  wallet.provider.on?.('accountChanged', changed); wallet.provider.on?.('disconnect', disconnected);
  state.detached = () => { wallet.provider.removeListener?.('accountChanged', changed); wallet.provider.removeListener?.('disconnect', disconnected); };
  return address;
}
export async function disconnectSolana(): Promise<void> {
  const state = session(); const provider = state.provider;
  state.version++; state.detached?.(); state.detached = undefined; state.provider = undefined; state.name = undefined; state.disconnected = true;
  await provider?.disconnect?.();
}
export function validateSolanaRoute(route: Route): void {
  if (route.id !== SOLANA_ROUTE_ID || route.walletType !== 'solana' || route.sourceChainId !== SOLANA_CHAIN_ID || route.sourceToken !== SOLANA_USDC || route.decimals !== 6 || route.symbol !== 'USDC') throw new Error('当前 Solana 网络、USDC 地址或精度不在已审核入金范围。');
}
export function validateSolanaQuote(quote: Quote, route: Route): void {
  validateSolanaRoute(route);
  if (quote.transaction.kind !== 'solana' || quote.transaction.chainId !== SOLANA_CHAIN_ID || quote.approval || quote.routeId !== route.id || !/^\d+(?:\.\d{1,6})?$/.test(quote.amount) || parseUnits(quote.amount, 6).toString() !== quote.amountBaseUnits) throw new Error('Solana 报价金额、网络或指令不一致，已阻止签名。');
  try { validateSolanaInstructions(quote.transaction.instructions, quote.sourceAddress, quote.amountBaseUnits, quote.protocolOrderId || ''); }
  catch { throw new Error('Solana 入金指令与本笔付款人、资产、金额或订单不一致。'); }
  if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('报价已到期。请重新获取报价，不要继续付款。');
}
export function verifySolanaWallet(route: Route, source: string, expected?: { provider: SolanaProvider; version: number }): void {
  validateSolanaRoute(route); solanaAddress(source);
  const state = session(); const provider = solanaProvider();
  if ((expected && (provider !== expected.provider || state.version !== expected.version)) || provider.isConnected === false || provider.publicKey?.toBase58() !== source) throw new Error('Solana 钱包账户或连接已变化，请重新连接订单中的付款账户。');
}
function connection(): Connection {
  // Never obtain RPC URLs from a quote, provider response or query parameter.
  return new Connection(SOLANA_RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }) });
}
async function mainnet(rpc: Connection): Promise<void> {
  if (await rpc.getGenesisHash() !== SOLANA_GENESIS_HASH) throw new Error('无法确认 Solana 主网，已阻止付款。');
}
function associatedTokenAddress(source: string): PublicKey {
  return PublicKey.findProgramAddressSync([new PublicKey(source).toBuffer(), new PublicKey(SOLANA_TOKEN_PROGRAM).toBuffer(), new PublicKey(SOLANA_USDC).toBuffer()], new PublicKey(SOLANA_ASSOCIATED_TOKEN_PROGRAM))[0];
}
async function tokenBalance(rpc: Connection, source: string): Promise<bigint> {
  const account = await rpc.getAccountInfo(associatedTokenAddress(source), 'confirmed');
  if (!account) return 0n;
  if (account.owner.toBase58() !== SOLANA_TOKEN_PROGRAM || account.data.length !== 165 || new PublicKey(account.data.subarray(0, 32)).toBase58() !== SOLANA_USDC || new PublicKey(account.data.subarray(32, 64)).toBase58() !== source || account.data[108] !== 1) throw new Error('无法核验 Solana 原生 USDC 账户，请检查资产和账户状态。');
  return account.data.readBigUInt64LE(64);
}
function lamports(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('无法取得可信的 SOL 余额或手续费。');
  return BigInt(value);
}
export async function solanaTokenBalance(route: Route, source: string): Promise<string> {
  const expected = { provider: solanaProvider(), version: session().version }; verifySolanaWallet(route, source, expected);
  const rpc = connection(); await mainnet(rpc); const balance = await tokenBalance(rpc, source);
  verifySolanaWallet(route, source, expected); return formatUnits(balance, 6);
}
export async function solanaNativeBalance(route: Route, source: string): Promise<string> {
  const expected = { provider: solanaProvider(), version: session().version }; verifySolanaWallet(route, source, expected);
  const rpc = connection(); await mainnet(rpc); const balance = lamports(await rpc.getBalance(new PublicKey(source), 'confirmed'));
  verifySolanaWallet(route, source, expected); return formatUnits(balance, 9);
}
function transactionFor(quote: Quote, block: BlockhashWithExpiryBlockHeight): Transaction {
  if (quote.transaction.kind !== 'solana') throw new Error('Solana 交易类型不正确。');
  const instructions = validateSolanaInstructions(quote.transaction.instructions, quote.sourceAddress, quote.amountBaseUnits, quote.protocolOrderId || '');
  const transaction = new Transaction({ feePayer: new PublicKey(quote.sourceAddress), ...block });
  transaction.add(...instructions.map(instruction => new TransactionInstruction({ programId: new PublicKey(instruction.programId), keys: instruction.keys.map(key => ({ ...key, pubkey: new PublicKey(key.pubkey) })), data: Buffer.from(instruction.data, 'hex') })));
  // No address lookup tables, extra signers, compute-budget or wallet-added instructions.
  if (transaction.compileMessage().header.numRequiredSignatures !== 1 || transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232) throw new Error('Solana 交易大小或签名人数超出已审核范围。');
  return transaction;
}
async function prepare(quote: Quote, route: Route) {
  validateSolanaQuote(quote, route);
  const expected = { provider: solanaProvider(), version: session().version }; verifySolanaWallet(route, quote.sourceAddress, expected);
  const rpc = connection(); await mainnet(rpc);
  const [balance, native, block] = await Promise.all([tokenBalance(rpc, quote.sourceAddress), rpc.getBalance(new PublicKey(quote.sourceAddress), 'confirmed'), rpc.getLatestBlockhash('confirmed')]);
  if (balance < BigInt(quote.amountBaseUnits)) throw new Error('付款钱包 USDC 余额不足，尚未请求付款签名。');
  if (lamports(native) === 0n) throw new Error('SOL 余额为零，请先补充 Solana 主网手续费。');
  const transaction = transactionFor(quote, block);
  const fee = (await rpc.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value;
  if (fee === null || lamports(fee) <= 0n) throw new Error('无法取得可信的 Solana 手续费，尚未请求签名。');
  if (lamports(native) < lamports(fee)) throw new Error('SOL 余额不足以支付本笔手续费，请补充后重试。');
  const simulation = await rpc.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', accounts: { addresses: [quote.sourceAddress], encoding: 'base64' } });
  if (simulation.value.err !== null || !simulation.value.accounts?.[0] || !Number.isSafeInteger(simulation.value.unitsConsumed) || simulation.value.unitsConsumed! <= 0) throw new Error('Solana 入金预检未通过，请检查 USDC、SOL 余额及账户状态后重新报价。');
  lamports(simulation.value.accounts[0].lamports);
  verifySolanaWallet(route, quote.sourceAddress, expected); validateSolanaQuote(quote, route);
  if (!(await rpc.isBlockhashValid(block.blockhash, { commitment: 'confirmed' })).value) throw new Error('Solana 交易有效期已结束，请重新报价。');
  verifySolanaWallet(route, quote.sourceAddress, expected); validateSolanaQuote(quote, route);
  return { rpc, transaction, block, expected };
}
export async function preflightSolanaPayment(quote: Quote, route: Route): Promise<void> { await prepare(quote, route); }
function signWithTimeout(provider: SolanaProvider, transaction: Transaction): Promise<Transaction> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Solana 签名请求超时。请核对原订单和钱包记录，不要重复付款。')), 120_000);
    Promise.resolve().then(() => provider.signTransaction(transaction)).then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}
export async function sendSolanaPayment(quote: Quote, route: Route, onHash: (hash: string) => void): Promise<string> {
  const { rpc, transaction, block, expected } = await prepare(quote, route);
  const reviewedMessage = Buffer.from(transaction.serializeMessage());
  const signed = await signWithTimeout(expected.provider, transaction);
  // Treat provider objects as untrusted: serialize, parse, then inspect that exact payload.
  let raw: Buffer; let checked: Transaction;
  try { raw = Buffer.from(signed.serialize({ requireAllSignatures: true, verifySignatures: true })); checked = Transaction.from(raw); }
  catch { throw new Error('Solana 签名无效或不完整，已阻止广播。'); }
  if (!checked.serializeMessage().equals(reviewedMessage) || checked.signatures.length !== 1 || !checked.signature || !checked.verifySignatures()) throw new Error('Solana 钱包改变了交易内容或签名无效，已阻止广播。');
  verifySolanaWallet(route, quote.sourceAddress, expected); validateSolanaQuote(quote, route);
  if (!(await rpc.isBlockhashValid(block.blockhash, { commitment: 'confirmed' })).value) throw new Error('Solana 交易有效期已结束，请核查原订单，不要重复付款。');
  verifySolanaWallet(route, quote.sourceAddress, expected); validateSolanaQuote(quote, route);
  const signature = bs58.encode(checked.signature);
  // A storage failure must stop here. Once this succeeds, an RPC failure is unknown,
  // never permission to sign a replacement transaction or silently retry a broadcast.
  onHash(signature);
  const result = await rpc.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
  if (result !== signature) throw new Error('Solana 广播结果无法确认，交易编号已保留，请继续核验原订单。');
  return signature;
}
