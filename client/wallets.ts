import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, isAddress, parseAbi, parseUnits, type Address, type EIP1193Provider, type Hex } from 'viem';
import type { Quote, Route } from '../shared/types.js';
import { REVIEWED_EVM_SOURCES, reviewedEvmSource } from '../shared/route-registry.js';
import { connectWalletConnect, disconnectWalletConnect, type WalletConnectOptions } from './walletconnect.js';

export interface BrowserProvider extends Pick<EIP1193Provider, 'request'> {
  isMetaMask?: boolean; isRabby?: boolean; providers?: BrowserProvider[];
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}
interface TronValue { owner_address?: string; contract_address?: string; data?: string; call_value?: number; call_token_value?: number; token_id?: number }
interface TronTransaction {
  txID?: string; raw_data_hex?: string; raw_data?: { fee_limit?: number; contract?: { type?: string; Permission_id?: number; parameter?: { value?: TronValue } }[] };
  signature?: string[];
}
interface TronContract {
  balanceOf: (owner: string) => { call: () => Promise<{ toString: (radix?: number) => string }> };
  allowance: (owner: string, spender: string) => { call: () => Promise<{ toString: (radix?: number) => string }> };
}
interface TronWeb {
  defaultAddress: { base58?: string; hex?: string };
  fullNode?: { host?: string };
  isAddress: (address: string) => boolean;
  utils?: { transaction?: { txCheck: (transaction: TronTransaction) => boolean } };
  address: { toHex: (address: string) => string; fromHex: (address: string) => string };
  contract: () => { at: (address: string) => Promise<TronContract> };
  transactionBuilder: { triggerSmartContract: (contract: string, selector: string, options: Record<string, unknown>, parameters: { type: string; value: string }[], owner: string) => Promise<{ result?: { result?: boolean }; transaction?: TronTransaction }> };
  trx: {
    sign: (transaction: TronTransaction) => Promise<TronTransaction>;
    sendRawTransaction: (transaction: TronTransaction) => Promise<{ result?: boolean; txid?: string; message?: string; code?: string }>;
    getTransactionInfo: (id: string) => Promise<{ id?: string; blockNumber?: number; receipt?: { result?: string }; result?: string }>;
  };
}
declare global { interface Window { ethereum?: BrowserProvider; tronLink?: { request: (input: { method: string }) => Promise<{ code?: number; message?: string }> }; tronWeb?: TronWeb } }

export const depositAbi = parseAbi(['function depositErc20(address payer, address token, uint256 amount, bytes32 id)']);
interface EvmSession { selected?: BrowserProvider; selectedKind?: 'injected' | 'walletconnect'; selectedName?: string; disconnected?: boolean; connectionVersion: number; announced: Map<BrowserProvider, { rdns: string; name: string }>; ids: Map<BrowserProvider, string>; requested: boolean }
const evmSessions = new WeakMap<Window, EvmSession>();
function evmSession(): EvmSession {
  let session = evmSessions.get(window);
  if (!session) {
    session = { announced: new Map(), ids: new Map(), requested: false, connectionVersion: 0 }; evmSessions.set(window, session);
    const current = session;
    window.addEventListener?.('eip6963:announceProvider', (event) => {
      const detail = (event as CustomEvent<{ info?: { rdns?: string; name?: string }; provider?: BrowserProvider }>).detail;
      if (detail?.provider && typeof detail.provider.request === 'function' && typeof detail.info?.rdns === 'string') current.announced.set(detail.provider, { rdns: detail.info.rdns, name: typeof detail.info.name === 'string' ? detail.info.name.slice(0, 80) : 'EVM 钱包' });
    });
  }
  return session;
}
function discoveredWallets(): { id: string; name: string; provider: BrowserProvider; priority: number }[] {
  const session = evmSession();
  // Request once after our persistent listener is installed. Later providers
  // announce themselves. Listing from a sync/async announcement must stay passive.
  if (!session.requested) {
    session.requested = true;
    window.dispatchEvent?.(new Event('eip6963:requestProvider'));
  }
  const root = window.ethereum;
  const candidates = [...new Set([...session.announced.keys(), ...(Array.isArray(root?.providers) ? root.providers : []), ...(root ? [root] : []), ...(session.selected && session.selectedKind !== 'walletconnect' ? [session.selected] : [])])];
  return candidates.filter(provider => provider && typeof provider.request === 'function').map(provider => {
    const info = session.announced.get(provider);
    const metaMask = info?.rdns === 'io.metamask' || (!info && provider.isMetaMask && !provider.isRabby);
    const rabby = info?.rdns === 'io.rabby' || (!info && provider.isRabby);
    if (!session.ids.has(provider)) session.ids.set(provider, `evm-wallet-${session.ids.size + 1}`);
    return { id: session.ids.get(provider)!, name: metaMask ? 'MetaMask' : rabby ? 'Rabby' : info?.name || '浏览器 EVM 钱包', provider, priority: info?.rdns === 'io.metamask' ? 0 : metaMask ? 1 : rabby ? 2 : 3 };
  }).sort((a, b) => a.priority - b.priority);
}
export function listEvmWallets(): { id: string; name: string }[] { return discoveredWallets().map(({ id, name }) => ({ id, name })); }
export function evmProvider(): BrowserProvider {
  // Once connected, all reads, events and transactions use that exact instance.
  const session = evmSession();
  if (session.disconnected) throw new Error('付款钱包已断开，请明确选择并重新连接钱包。');
  const selected = session.selected;
  if (selected) return selected;
  const provider = discoveredWallets()[0]?.provider;
  if (!provider) throw new Error('未检测到浏览器 EVM 钱包。请安装并解锁 MetaMask 或 Rabby 后重试。');
  return provider;
}
export async function connectEvm(walletId?: string, wcOptions?: WalletConnectOptions): Promise<string> {
  const session = evmSession();
  const version = ++session.connectionVersion;
  const usingWalletConnect = walletId === 'walletconnect';
  let provider: BrowserProvider;
  let name: string;
  if (usingWalletConnect) {
    if (!wcOptions) throw new Error('本站尚未配置 WalletConnect，请联系部署团队。');
    provider = await connectWalletConnect(wcOptions); name = 'WalletConnect';
  } else {
    // An explicit connect without an id means the preferred injected wallet.
    // Execution reads never use this path and remain pinned to their provider.
    const wallet = walletId === undefined ? discoveredWallets()[0] : discoveredWallets().find(wallet => wallet.id === walletId);
    if (!wallet) throw new Error('所选钱包当前不可用，请安装并解锁 MetaMask 或 Rabby，或选择 WalletConnect。');
    void disconnectWalletConnect();
    provider = wallet.provider; name = wallet.name;
  }
  try {
    const accounts = await provider.request({ method: usingWalletConnect ? 'eth_accounts' : 'eth_requestAccounts' });
    if (version !== session.connectionVersion || wcOptions?.signal?.aborted) throw new Error('钱包连接请求已取消或被新的连接替代，请重试。');
    if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || !isAddress(accounts[0])) throw new Error('钱包没有提供有效账户，请解锁钱包后重试。');
    if (usingWalletConnect && await providerChain(provider) !== wcOptions!.chainId) throw new Error('WalletConnect 钱包网络已变化，请重新连接所选网络。');
    if (version !== session.connectionVersion || wcOptions?.signal?.aborted) throw new Error('钱包连接请求已取消或被新的连接替代，请重试。');
    session.selected = provider; session.selectedKind = usingWalletConnect ? 'walletconnect' : 'injected'; session.selectedName = name; session.disconnected = false;
    return accounts[0];
  } catch (error) {
    if (usingWalletConnect && version === session.connectionVersion) await disconnectWalletConnect();
    throw error;
  }
}
export function selectedEvmWalletName(): string | undefined { return evmSession().selectedName; }
export function isWalletConnectSelected(): boolean { return evmSession().selectedKind === 'walletconnect'; }
export async function disconnectEvm(): Promise<void> {
  const session = evmSession(); session.connectionVersion++; session.disconnected = true;
  await disconnectWalletConnect();
}
function rpcQuantity(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error(`钱包未返回有效的${label}，请重试读取，不要重复付款。`);
  return BigInt(value);
}
async function providerChain(provider: BrowserProvider): Promise<number> {
  const chain = rpcQuantity(await provider.request({ method: 'eth_chainId' }), '网络编号');
  if (chain > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('钱包网络编号超出可验证范围。');
  return Number(chain);
}
export async function getEvmChain(): Promise<number> { return providerChain(evmProvider()); }
export async function switchEvmChain(chainId: number): Promise<void> {
  const entry = REVIEWED_EVM_SOURCES.find(source => source.route.sourceChainId === chainId);
  if (!entry) throw new Error('请求的网络不在当前已审核入金范围。');
  const provider = evmProvider();
  const hexChain = `0x${chainId.toString(16)}`;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hexChain, chainName: entry.route.sourceChain, nativeCurrency: { name: entry.route.gasSymbol!, symbol: entry.route.gasSymbol!, decimals: 18 }, rpcUrls: [entry.publicRpcUrl], blockExplorerUrls: [entry.explorerUrl] }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain }] });
  }
  if (evmProvider() !== provider || await providerChain(provider) !== chainId) throw new Error(`钱包尚未切换到 ${entry.route.sourceChain}，请在钱包中核对。`);
}
function tronWeb(): TronWeb {
  const tron = window.tronWeb;
  if (!window.tronLink || !tron?.defaultAddress.base58) throw new Error('请先连接并解锁 TronLink。');
  return tron;
}
export function requireTronMainnet(tron: Pick<TronWeb, 'fullNode'>): void {
  let node: URL;
  try { node = new URL(tron.fullNode?.host || ''); } catch { throw new Error('无法核验 TronLink 网络，请在钱包中切换到官方 Tron 主网节点。'); }
  if (node.protocol !== 'https:' || (node.port !== '' && node.port !== '443') || node.username || node.password || !['api.trongrid.io', 'api.tronstack.io', 'tron-rpc.publicnode.com'].includes(node.hostname)) throw new Error('请在 TronLink 切换到 Tron 主网（TronGrid）。当前节点未列入本产品验证范围。');
}
export async function connectTron(): Promise<string> {
  if (!window.tronLink) throw new Error('未检测到 TronLink。请安装并解锁 TronLink 浏览器扩展后重试。');
  const result = await window.tronLink.request({ method: 'tron_requestAccounts' });
  if (result?.code && result.code !== 200) throw new Error(result.message || 'TronLink 未授权连接。');
  const tron = tronWeb(); requireTronMainnet(tron);
  if (!tron.isAddress(tron.defaultAddress.base58!)) throw new Error('TronLink 返回的付款地址无效。');
  return tron.defaultAddress.base58!;
}
export function isWalletRejection(error: unknown): boolean {
  const value = error as { code?: number; message?: string; cause?: unknown };
  return value?.code === 4001 || /user rejected|user denied|confirmation declined|用户拒绝|取消签名/i.test(value?.message || '') || (!!value?.cause && isWalletRejection(value.cause));
}
export function walletAddressEquals(route: Pick<Route, 'walletType'>, first: string, second: string): boolean {
  return route.walletType === 'tron' ? first === second : first.toLowerCase() === second.toLowerCase();
}
function validateEvmRoute(route: Route) {
  const entry = reviewedEvmSource(route.id);
  if (!entry || route.walletType !== 'evm' || route.sourceChainId !== entry.route.sourceChainId || route.sourceToken.toLowerCase() !== entry.route.sourceToken.toLowerCase() || route.decimals !== entry.route.decimals || route.symbol !== entry.route.symbol) throw new Error('当前网络、代币合约或精度不在已审核入金范围，已阻止操作。');
  return entry;
}
function validateEvmDeposit(quote: Quote, route: Route): void {
  const entry = validateEvmRoute(route);
  const tx = quote.transaction;
  if (tx.kind !== 'evm' || tx.chainId !== route.sourceChainId || tx.to.toLowerCase() !== entry.depository.toLowerCase() || !/^0x(?:[0-9a-f]{2})+$/i.test(tx.data) || !/^\d+$/.test(tx.value) || BigInt(tx.value) !== 0n || !isAddress(quote.sourceAddress)) throw new Error('入金合约、网络或原生金额不正确，已阻止签名。');
  if (!/^\d+(?:\.\d+)?$/.test(quote.amount) || (quote.amount.split('.')[1]?.length || 0) > route.decimals || parseUnits(quote.amount, route.decimals) !== BigInt(quote.amountBaseUnits)) throw new Error('入金显示金额与精确付款数量不一致。');
  if (!/^0x[0-9a-f]{64}$/i.test(quote.protocolOrderId || '') || /^0x0{64}$/i.test(quote.protocolOrderId!)) throw new Error('报价缺少已核验的协议订单编号，请重新报价。');
  if (quote.approval && (quote.approval.token.toLowerCase() !== route.sourceToken.toLowerCase() || quote.approval.spender.toLowerCase() !== entry.depository.toLowerCase())) throw new Error('授权资产或对象不是已审核的合约。');
  let decoded;
  try { decoded = decodeFunctionData({ abi: depositAbi, data: tx.data as Hex }); }
  catch { throw new Error('入金 calldata 无法验证，已阻止签名。'); }
  const [payer, token, amount, id] = decoded.args;
  if (decoded.functionName !== 'depositErc20' || payer.toLowerCase() !== quote.sourceAddress.toLowerCase() || token.toLowerCase() !== route.sourceToken.toLowerCase() || amount !== BigInt(quote.amountBaseUnits) || id.toLowerCase() !== quote.protocolOrderId!.toLowerCase() || encodeFunctionData({ abi: depositAbi, functionName: 'depositErc20', args: [payer, token, amount, id] }).toLowerCase() !== tx.data.toLowerCase()) throw new Error('入金付款人、币种、金额或协议订单不一致，已阻止签名。');
}
export function validateQuoteContext(quote: Quote, route: Route, sourceAddress: string, recipient: string): void {
  if (quote.routeId !== route.id || !walletAddressEquals(route, quote.sourceAddress, sourceAddress) || quote.recipient.toLowerCase() !== recipient.toLowerCase()) throw new Error('报价与当前付款或收款账户不一致，请重新报价。');
  if (!isAddress(quote.recipient) || !/^\d+$/.test(quote.amountBaseUnits) || BigInt(quote.amountBaseUnits) <= 0n) throw new Error('报价金额或接收地址无效，已阻止签名。');
  if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) throw new Error('报价已到期。请重新获取报价，不要继续付款。');
  if (quote.transaction.kind !== route.walletType) throw new Error('交易类型与来源网络不一致。');
  if (quote.approval && (!walletAddressEquals(route, quote.approval.token, route.sourceToken) || !/^\d+$/.test(quote.approval.amount) || BigInt(quote.approval.amount) !== BigInt(quote.amountBaseUnits))) throw new Error('授权资产或额度与订单不一致，已阻止签名。');
  if (quote.transaction.kind === 'evm') {
    if (quote.transaction.chainId !== route.sourceChainId || !isAddress(quote.transaction.to) || !/^0x[0-9a-f]*$/i.test(quote.transaction.data) || !/^\d+$/.test(quote.transaction.value)) throw new Error('交易网络或参数不正确，已阻止签名。');
    validateEvmDeposit(quote, route);
  }
}
async function verifyWallet(route: Route, source: string, selected?: BrowserProvider): Promise<void> {
  if (route.walletType === 'evm') {
    validateEvmRoute(route);
    const provider = selected || evmProvider();
    if (selected && evmProvider() !== selected) throw new Error('付款钱包已变化，请重新连接原付款钱包。');
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (accounts[0]?.toLowerCase() !== source.toLowerCase()) throw new Error('钱包账户已变化，请切回订单中的付款账户。');
    if (await providerChain(provider) !== route.sourceChainId) throw new Error(`请先将钱包切换到 ${route.sourceChain}。`);
  } else {
    const tron = tronWeb(); requireTronMainnet(tron);
    if (!tron.isAddress(source) || !tron.isAddress(route.sourceToken)) throw new Error('Tron 付款地址或代币地址无效，已阻止操作。');
    if (tron.defaultAddress.base58 !== source) throw new Error('TronLink 账户已变化，请切回订单中的付款账户。');
  }
}
export async function sourceBalance(route: Route, source: string): Promise<string> {
  await verifyWallet(route, source);
  if (route.walletType === 'evm') {
    const provider = evmProvider();
    const client = createPublicClient({ transport: custom(provider, { retryCount: 0 }) });
    const value = await client.readContract({ address: route.sourceToken as Address, abi: erc20Abi, functionName: 'balanceOf', args: [source as Address] });
    await verifyWallet(route, source, provider);
    return formatUnits(value, route.decimals);
  }
  const contract = await tronWeb().contract().at(route.sourceToken);
  return formatUnits(BigInt((await contract.balanceOf(source).call()).toString(10)), route.decimals);
}
export async function sourceNativeBalance(route: Route, source: string): Promise<string> {
  validateEvmRoute(route);
  const provider = evmProvider();
  await verifyWallet(route, source, provider);
  const balance = rpcQuantity(await provider.request({ method: 'eth_getBalance', params: [source as Address, 'latest'] }), '原生手续费余额');
  await verifyWallet(route, source, provider);
  return formatUnits(balance, 18);
}
async function assertEvmGas(provider: BrowserProvider, quote: Quote, route: Route, to: string, data: Hex): Promise<void> {
  await verifyWallet(route, quote.sourceAddress, provider);
  const balance = rpcQuantity(await provider.request({ method: 'eth_getBalance', params: [quote.sourceAddress as Address, 'latest'] }), '原生手续费余额');
  const gasSymbol = validateEvmRoute(route).route.gasSymbol || '原生代币';
  if (balance === 0n) throw new Error(`${route.sourceChain} ${gasSymbol} 余额为零，请先补充链上手续费。`);
  // These are a current estimate for this call, not a total multi-step budget.
  // In particular, L2 settlement/data fees can require additional native funds.
  const gas = rpcQuantity(await provider.request({ method: 'eth_estimateGas', params: [{ from: quote.sourceAddress as Address, to: to as Address, data, value: '0x0' }] }), '本笔Gas估算');
  const price = rpcQuantity(await provider.request({ method: 'eth_gasPrice' }), 'Gas价格估算');
  if (gas <= 0n || price <= 0n) throw new Error('无法取得可靠的链上手续费估算，尚未请求签名，请稍后重试。');
  if (balance < gas * price) throw new Error(`${gasSymbol} 余额不足以覆盖本笔当前估算手续费，请补充后重新检查。`);
  await verifyWallet(route, quote.sourceAddress, provider);
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
}
export async function preflightPayment(quote: Quote, route: Route): Promise<void> {
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  const provider = route.walletType === 'evm' ? evmProvider() : undefined;
  await verifyWallet(route, quote.sourceAddress, provider);
  const balance = await sourceBalance(route, quote.sourceAddress);
  if (parseUnits(balance, route.decimals) < BigInt(quote.amountBaseUnits)) throw new Error(`付款钱包 ${route.symbol} 余额不足，尚未请求付款签名。`);
  if (await getAllowance(quote, route) < BigInt(quote.amountBaseUnits)) throw new Error('本笔授权额度不足，请先完成授权。');
  if (quote.transaction.kind === 'evm') await assertEvmGas(provider!, quote, route, quote.transaction.to, quote.transaction.data as Hex);
  await verifyWallet(route, quote.sourceAddress, provider);
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
}
export async function getAllowance(quote: Quote, route: Route): Promise<bigint> {
  if (route.walletType === 'evm') validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  await verifyWallet(route, quote.sourceAddress);
  const token = quote.approval?.token || route.sourceToken;
  const spender = quote.approval?.spender || (quote.transaction.kind === 'tron' ? quote.transaction.contractAddress : quote.transaction.to);
  if (!spender || !walletAddressEquals(route, token, route.sourceToken)) throw new Error('无法核验本笔授权对象，请重新获取报价。');
  if (route.walletType === 'evm') {
    const provider = evmProvider();
    const value = await createPublicClient({ transport: custom(provider, { retryCount: 0 }) }).readContract({ address: token as Address, abi: erc20Abi, functionName: 'allowance', args: [quote.sourceAddress as Address, spender as Address] });
    await verifyWallet(route, quote.sourceAddress, provider);
    return value;
  }
  if (quote.transaction.kind !== 'tron' || !quote.transaction.contractAddress || spender !== quote.transaction.contractAddress) throw new Error('Tron 路由目标与授权对象不一致。');
  const tron = tronWeb();
  normalizeTron(tron, spender);
  const contract = await tron.contract().at(token);
  return BigInt((await contract.allowance(quote.sourceAddress, spender).call()).toString(10));
}
function normalizeTron(tron: TronWeb, address: string): string {
  if (!tron.isAddress(address)) throw new Error('Tron 地址无效，已阻止签名。');
  const hex = tron.address.toHex(address).replace(/^0x/, '').toLowerCase();
  if (!/^41[0-9a-f]{40}$/.test(hex)) throw new Error('Tron 地址编码无效，已阻止签名。');
  return hex;
}
export function validateTronBuilt(tron: TronWeb, tx: TronTransaction, owner: string, contract: string, data: string): void {
  const entries = tx.raw_data?.contract;
  const value = entries?.[0]?.parameter?.value;
  const feeLimit = tx.raw_data?.fee_limit;
  const allowedValueKeys = ['owner_address', 'contract_address', 'data', 'call_value'];
  if (!Number.isSafeInteger(feeLimit) || feeLimit! <= 0 || feeLimit! > 150_000_000 || !value || Object.keys(value).some((key) => !allowedValueKeys.includes(key)) || (entries?.[0]?.Permission_id || 0) !== 0) throw new Error('Tron 交易包含额外资金动作、权限或超出上限的手续费，已阻止签名。');
  if (!tx.txID || !/^[0-9a-f]{64}$/i.test(tx.txID) || entries?.length !== 1 || entries[0]?.type !== 'TriggerSmartContract' || !value?.owner_address || !value.contract_address || normalizeTron(tron, value.owner_address) !== normalizeTron(tron, owner) || normalizeTron(tron, value.contract_address) !== normalizeTron(tron, contract) || value.data?.toLowerCase() !== data.replace(/^0x/, '').toLowerCase() || (value.call_value || 0) !== 0) throw new Error('Tron 钱包构造的交易与已审核参数不一致，已阻止签名。');
}
async function buildTron(tron: TronWeb, owner: string, contract: string, selector: string, parameters: { type: string; value: string }[], data: string): Promise<TronTransaction> {
  const built = await tron.transactionBuilder.triggerSmartContract(contract, selector, { feeLimit: 150_000_000, callValue: 0 }, parameters, owner);
  if (!built.result?.result || !built.transaction) throw new Error('TronLink 无法构造交易，请检查主网资源与余额。');
  validateTronBuilt(tron, built.transaction, owner, contract, data);
  if (!tron.utils?.transaction?.txCheck || !tron.utils.transaction.txCheck(built.transaction)) throw new Error('Tron 钱包无法核验交易编码，请更新 TronLink 后重试。');
  return built.transaction;
}
async function broadcastTron(tron: TronWeb, transaction: TronTransaction, beforeBroadcast?: (hash: string) => void): Promise<string> {
  // Capture the reviewed intent before calling a wallet that may mutate its argument.
  const expectedId = transaction.txID;
  const expectedHex = transaction.raw_data_hex;
  const expectedRaw = JSON.stringify(transaction.raw_data);
  const value = transaction.raw_data!.contract![0]!.parameter!.value!;
  const owner = value.owner_address!, contract = value.contract_address!, data = value.data!;
  const signed = await tron.trx.sign(transaction);
  validateTronBuilt(tron, signed, owner, contract, data);
  if (!signed.signature?.length || signed.txID !== expectedId || signed.raw_data_hex !== expectedHex || JSON.stringify(signed.raw_data) !== expectedRaw || !tron.utils?.transaction?.txCheck(signed)) throw new Error('Tron 签名未完成或交易内容被改变，已阻止广播。');
  beforeBroadcast?.(signed.txID!);
  const result = await tron.trx.sendRawTransaction(signed);
  if (!result.result) throw new Error(`Tron 广播未确认（${result.code || 'UNKNOWN'}）。请先在钱包或浏览器核对交易，不要再次付款。`);
  return signed.txID!;
}
async function waitTron(tron: TronWeb, hash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const receipt = await tron.trx.getTransactionInfo(hash);
    if (receipt.blockNumber !== undefined) {
      if ((receipt.receipt?.result && receipt.receipt.result !== 'SUCCESS') || receipt.result === 'FAILED') throw new Error('授权交易执行失败，请检查 Tron 资源。');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('授权仍在确认中，请稍后检查授权状态，不要重复提交。');
}
async function sendEvm(provider: BrowserProvider, chainId: number, from: string, to: string, data: Hex): Promise<Hex> {
  // Exactly one provider call: no transport retry or alternative send method.
  // The wallet owns signing+broadcast, so a transport error may be a sent tx.
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: from as Address, to: to as Address, data, value: '0x0', chainId: `0x${chainId.toString(16)}` }] });
  if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('钱包未返回有效交易编号，付款结果需核查；请勿重复提交。');
  return hash;
}
async function waitEvmApproval(provider: BrowserProvider, route: Route, source: string, hash: Hex): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await verifyWallet(route, source, provider);
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    await verifyWallet(route, source, provider);
    if (receipt !== null) {
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || typeof receipt.transactionHash !== 'string' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || typeof receipt.from !== 'string' || receipt.from.toLowerCase() !== source.toLowerCase() || typeof receipt.to !== 'string' || receipt.to.toLowerCase() !== route.sourceToken.toLowerCase() || typeof receipt.blockNumber !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(receipt.blockNumber) || typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash)) throw new Error('授权凭证与本次操作不一致或尚未包含有效区块。');
      if (receipt.status !== '0x1') throw new Error('授权交易执行失败，未执行付款。');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('授权仍在确认中，请先检查钱包记录和链上额度，不要重复提交。');
}
export async function approveExact(quote: Quote, route: Route, onStep: (message: string) => void): Promise<void> {
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  await verifyWallet(route, quote.sourceAddress);
  const allowance = await getAllowance(quote, route);
  const required = BigInt(quote.amountBaseUnits);
  if (!quote.approval) {
    if (allowance < required) throw new Error('当前代币授权额度不足，请重新获取包含授权步骤的报价。');
    return;
  }
  if (allowance >= required) return;
  const provider = route.walletType === 'evm' ? evmProvider() : undefined;
  const resetNeeded = route.walletType === 'tron' || validateEvmRoute(route).approvalPolicy === 'reset-if-needed';
  const amounts = allowance > 0n && resetNeeded ? [0n, required] : [required];
  for (const amount of amounts) {
    onStep(amount === 0n ? '先在钱包将旧额度归零，随后只授权本笔金额。' : '请在钱包确认精确授权，等待链上确认。');
    await verifyWallet(route, quote.sourceAddress);
    validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
    if (route.walletType === 'evm') {
      await verifyWallet(route, quote.sourceAddress, provider);
      validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [quote.approval.spender as Address, amount] });
      await assertEvmGas(provider!, quote, route, quote.approval.token, data);
      const hash = await sendEvm(provider!, route.sourceChainId, quote.sourceAddress, quote.approval.token, data);
      await waitEvmApproval(provider!, route, quote.sourceAddress, hash);
      if (await getAllowance(quote, route) !== amount) throw new Error('链上授权额度与本次精确授权不一致，已停止后续操作。');
    } else {
      const tron = tronWeb();
      const spenderEvm = `0x${normalizeTron(tron, quote.approval.spender).slice(2)}` as Address;
      const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spenderEvm, amount] });
      const transaction = await buildTron(tron, quote.sourceAddress, quote.approval.token, 'approve(address,uint256)', [{ type: 'address', value: quote.approval.spender }, { type: 'uint256', value: amount.toString() }], data);
      await verifyWallet(route, quote.sourceAddress);
      validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
      await waitTron(tron, await broadcastTron(tron, transaction));
    }
  }
}
export async function sendPayment(quote: Quote, route: Route, onHash: (hash: string) => void): Promise<string> {
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  await verifyWallet(route, quote.sourceAddress);
  if (await getAllowance(quote, route) < BigInt(quote.amountBaseUnits)) throw new Error('本笔授权额度不足，请先完成授权。');
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  if (quote.transaction.kind === 'evm') {
    const tx = quote.transaction;
    const provider = evmProvider();
    await preflightPayment(quote, route);
    await verifyWallet(route, quote.sourceAddress, provider);
    validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
    const hash = await sendEvm(provider, route.sourceChainId, quote.sourceAddress, tx.to, tx.data as Hex);
    // Do not wait for a receipt or revalidate expiry after broadcast before saving.
    onHash(hash); return hash;
  }
  const tron = tronWeb();
  const raw = quote.transaction.transaction as { type?: string; parameter?: TronValue };
  if (raw.type !== 'TriggerSmartContract' || !raw.parameter?.owner_address || !raw.parameter.contract_address || !raw.parameter.data || normalizeTron(tron, raw.parameter.owner_address) !== normalizeTron(tron, quote.sourceAddress) || (raw.parameter.call_value || 0) !== 0 || raw.parameter.call_token_value !== undefined || raw.parameter.token_id !== undefined) throw new Error('Tron 交易参数无法验证，已阻止签名。');
  const contract = raw.parameter.contract_address;
  if (!quote.transaction.contractAddress || normalizeTron(tron, quote.transaction.contractAddress) !== normalizeTron(tron, contract) || (quote.approval && normalizeTron(tron, quote.approval.spender) !== normalizeTron(tron, contract))) throw new Error('Tron 路由目标与授权对象不一致。');
  const data = `0x${raw.parameter.data.replace(/^0x/, '')}` as Hex;
  const decoded = decodeFunctionData({ abi: depositAbi, data });
  if (decoded.functionName !== 'depositErc20') throw new Error('当前版本不支持此 Tron 入金函数。');
  const [payer, token, amount, id] = decoded.args;
  const payerTron = tron.address.fromHex(`41${payer.slice(2)}`);
  const tokenTron = tron.address.fromHex(`41${token.slice(2)}`);
  if (payerTron !== quote.sourceAddress || normalizeTron(tron, tokenTron) !== normalizeTron(tron, route.sourceToken) || amount !== BigInt(quote.amountBaseUnits)) throw new Error('Tron 入金付款人、币种或金额与订单不一致。');
  const transaction = await buildTron(tron, quote.sourceAddress, contract, 'depositErc20(address,address,uint256,bytes32)', [{ type: 'address', value: payerTron }, { type: 'address', value: tokenTron }, { type: 'uint256', value: amount.toString() }, { type: 'bytes32', value: id }], data);
  await verifyWallet(route, quote.sourceAddress);
  validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
  return broadcastTron(tron, transaction, (hash) => {
    // TronLink signs without broadcasting. A user can leave its prompt open past expiry.
    validateQuoteContext(quote, route, quote.sourceAddress, quote.recipient);
    onHash(hash);
  });
}
