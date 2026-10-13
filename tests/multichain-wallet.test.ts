/** Only injected EIP-1193 observations are faked. Real wallet validation,
 * encoding, route registry and preflight execute without a network connection. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, formatUnits, parseUnits, toHex, type Hex } from 'viem';
import { REVIEWED_EVM_SOURCES, type ReviewedEvmSource } from '../shared/route-registry.js';
import type { Quote, Route } from '../shared/types.js';
import { approveExact, connectEvm, depositAbi, evmProvider, getEvmChain, listEvmWallets, preflightPayment, sendPayment, sourceNativeBalance, switchEvmChain, type BrowserProvider } from '../client/wallets.js';

const source = '0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e';
const other = '0x1111111111111111111111111111111111111111';
function quote(entry: ReviewedEvmSource): Quote {
  const key = entry.route.id.replace('-hypercore', '');
  const raw = JSON.parse(readFileSync(new URL(`./fixtures/multichain/${key}-quote.json`, import.meta.url), 'utf8'));
  const tx = raw.steps.find((step: { id: string }) => step.id === 'deposit').items[0].data;
  return { id: `wallet-${key}`, routeId: entry.route.id, sourceAddress: raw.details.sender, recipient: raw.details.recipient,
    protocolOrderId: raw.protocol.v2.orderId, amount: formatUnits(BigInt(raw.details.currencyIn.amount), entry.route.decimals), amountBaseUnits: raw.details.currencyIn.amount,
    expectedReceive: formatUnits(BigInt(raw.details.currencyOut.amount), 8), minReceive: formatUnits(BigInt(raw.details.currencyOut.minimumAmount), 8),
    expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay', fees: [], warnings: [],
    approval: { token: entry.route.sourceToken, spender: entry.depository, amount: raw.details.currencyIn.amount },
    transaction: { kind: 'evm', chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value } };
}
type Sent = { from: string; to: string; data: Hex; value: string; chainId: string };
function wallet(entry = REVIEWED_EVM_SOURCES[0]!) {
  const state = { chain: toHex(entry.route.sourceChainId) as string, account: source, native: 10n ** 18n, tokens: 10000n * 10n ** BigInt(entry.route.decimals), allowance: 10000n * 10n ** BigInt(entry.route.decimals),
    balanceRaw: undefined as unknown, estimateError: undefined as unknown, estimateGas: 100000n, gasPrice: 1000000000n, unknownChain: false, switchWrong: false,
    afterEstimate: undefined as (() => void) | undefined, afterReceipt: undefined as (() => void) | undefined, connectError: undefined as unknown };
  const sent: Sent[] = []; const added: unknown[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: any }) => {
    if (method === 'eth_requestAccounts') { if (state.connectError) throw state.connectError; return [state.account]; }
    if (method === 'eth_accounts') return [state.account];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return state.balanceRaw ?? toHex(state.native);
    if (method === 'eth_estimateGas') { if (state.estimateError) throw state.estimateError; state.afterEstimate?.(); return toHex(state.estimateGas); }
    if (method === 'eth_gasPrice') return toHex(state.gasPrice);
    if (method === 'eth_call') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: params[0].data });
      expect(params[0].to.toLowerCase()).toBe(entry.route.sourceToken.toLowerCase());
      return toHex(decoded.functionName === 'allowance' ? state.allowance : state.tokens, { size: 32 });
    }
    if (method === 'wallet_switchEthereumChain') {
      if (state.unknownChain) throw { code: 4902, message: 'Unrecognized chain' };
      if (!state.switchWrong) state.chain = params[0].chainId; return null;
    }
    if (method === 'wallet_addEthereumChain') { added.push(structuredClone(params[0])); state.unknownChain = false; return null; }
    if (method === 'eth_sendTransaction') { sent.push(structuredClone(params[0])); return toHex(sent.length, { size: 32 }); }
    if (method === 'eth_getTransactionReceipt') {
      const tx = sent[Number(BigInt(params[0])) - 1]!;
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName === 'approve') state.allowance = decoded.args[1];
      state.afterReceipt?.();
      return { transactionHash: params[0], from: tx.from, to: tx.to, blockHash: toHex(42, { size: 32 }), blockNumber: '0x2a', status: '0x1' };
    }
    throw new Error(`Unexpected isolated RPC: ${method}`);
  });
  return { state, sent, added, request, provider: { isMetaMask: true, request } as BrowserProvider };
}
function browser(provider?: BrowserProvider) {
  const target = new EventTarget();
  const page = { ethereum: provider, addEventListener: target.addEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) };
  vi.stubGlobal('window', page);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No live requests in wallet tests'); }));
  return page;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('reviewed chain/token wallet execution', () => {
  it.each(REVIEWED_EVM_SOURCES.map(entry => [entry.route.id, entry] as const))('sends the captured reviewed deposit on %s without changing its precision or chain', async (_name, entry) => {
    const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; browser(w.provider);
    await connectEvm(); expect(await sourceNativeBalance(entry.route, q.sourceAddress)).toBe('1');
    await preflightPayment(q, entry.route); expect(w.sent).toHaveLength(0);
    const onHash = vi.fn(); await sendPayment(q, entry.route, onHash);
    if (q.transaction.kind !== 'evm') throw new Error('fixture');
    expect(w.sent).toEqual([{ from: q.sourceAddress, to: q.transaction.to, data: q.transaction.data, value: '0x0', chainId: toHex(entry.route.sourceChainId) }]);
    expect(decodeFunctionData({ abi: depositAbi, data: w.sent[0]!.data }).args[2]).toBe(parseUnits(q.amount, entry.route.decimals));
    expect(onHash).toHaveBeenCalledExactlyOnceWith(toHex(1, { size: 32 }));
  });
  it('preserves the last of all 18 decimals for BNB Binance-Peg USDT', async () => {
    const entry = REVIEWED_EVM_SOURCES.find(e => e.route.sourceChainId === 56)!; const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; browser(w.provider);
    q.amount = '10.000000000000000001'; q.amountBaseUnits = '10000000000000000001'; q.approval!.amount = q.amountBaseUnits;
    if (q.transaction.kind !== 'evm') throw new Error('fixture');
    q.transaction.data = encodeFunctionData({ abi: depositAbi, functionName: 'depositErc20', args: [q.sourceAddress as Hex, entry.route.sourceToken as Hex, BigInt(q.amountBaseUnits), q.protocolOrderId as Hex] });
    await sendPayment(q, entry.route, vi.fn());
    expect(decodeFunctionData({ abi: depositAbi, data: w.sent[0]!.data }).args[2]).toBe(10000000000000000001n);
  });
  it.each(['token', 'chain', 'decimals', 'symbol', 'unknown-route'] as const)('rejects a client/config substituted %s before any wallet RPC', async kind => {
    const entry = REVIEWED_EVM_SOURCES[0]!; const q = quote(entry); const route: Route = { ...entry.route }; const w = wallet(entry); browser(w.provider);
    if (kind === 'token') route.sourceToken = other;
    if (kind === 'chain') route.sourceChainId = 56;
    if (kind === 'decimals') route.decimals = 18;
    if (kind === 'symbol') route.symbol = 'USDC';
    if (kind === 'unknown-route') { route.id = 'unreviewed-usdt'; q.routeId = route.id; }
    await expect(preflightPayment(q, route)).rejects.toThrow(); expect(w.request).not.toHaveBeenCalled();
  });
  it.each(['zero-native', 'insufficient-native', 'insufficient-token', 'estimate-error', 'malformed-native', 'zero-gas-price'] as const)('blocks %s before a signing request', async kind => {
    const entry = REVIEWED_EVM_SOURCES[0]!; const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; browser(w.provider);
    if (kind === 'zero-native') w.state.native = 0n;
    if (kind === 'insufficient-native') w.state.native = 1n;
    if (kind === 'insufficient-token') w.state.tokens = 0n;
    if (kind === 'estimate-error') w.state.estimateError = new Error('Estimate temporarily unavailable');
    if (kind === 'malformed-native') w.state.balanceRaw = '1.0';
    if (kind === 'zero-gas-price') w.state.gasPrice = 0n;
    await expect(preflightPayment(q, entry.route)).rejects.toThrow();
    await expect(sendPayment(q, entry.route, vi.fn())).rejects.toThrow(); expect(w.sent).toHaveLength(0);
  });
  it.each(['chain', 'account', 'expiry'] as const)('revalidates %s after the fee-estimation awaits', async kind => {
    const entry = REVIEWED_EVM_SOURCES[0]!; const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; browser(w.provider);
    w.state.afterEstimate = () => { if (kind === 'chain') w.state.chain = '0x38'; if (kind === 'account') w.state.account = other; if (kind === 'expiry') q.expiresAt = '2000-01-01T00:00:00Z'; };
    await expect(sendPayment(q, entry.route, vi.fn())).rejects.toThrow(); expect(w.sent).toHaveLength(0);
  });
  it('blocks approval with no native gas, including after a mined reset depleted it', async () => {
    const entry = REVIEWED_EVM_SOURCES[0]!; const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; browser(w.provider); w.state.allowance = 1n; w.state.native = 0n;
    await expect(approveExact(q, entry.route, vi.fn())).rejects.toThrow(/余额为零/); expect(w.sent).toHaveLength(0);
    w.state.native = 10n ** 18n; w.state.afterReceipt = () => { w.state.native = 0n; };
    await expect(approveExact(q, entry.route, vi.fn())).rejects.toThrow(/余额为零/); expect(w.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: erc20Abi, data: w.sent[0]!.data }).args?.[1]).toBe(0n);
  });
  it('uses the selected chain token for approval and receipt validation', async () => {
    const entry = REVIEWED_EVM_SOURCES.find(e => e.route.id === 'base-usdc-hypercore')!; const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; w.state.allowance = 0n; browser(w.provider);
    await approveExact(q, entry.route, vi.fn());
    expect(w.sent).toHaveLength(1); expect(w.sent[0]!.to.toLowerCase()).toBe(entry.route.sourceToken); expect(w.sent[0]!.chainId).toBe('0x2105');
    expect(w.state.allowance).toBe(BigInt(q.amountBaseUnits));
  });
  it.each(REVIEWED_EVM_SOURCES.filter(entry => entry.approvalPolicy === 'exact').map(entry => [entry.route.id, entry] as const))('uses one exact approval for insufficient nonzero allowance on %s', async (_name, entry) => {
    const q = quote(entry); const w = wallet(entry); w.state.account = q.sourceAddress; w.state.allowance = 1n; browser(w.provider);
    await approveExact(q, entry.route, vi.fn());
    expect(w.sent).toHaveLength(1);
    expect(decodeFunctionData({ abi: erc20Abi, data: w.sent[0]!.data }).args?.[1]).toBe(BigInt(q.amountBaseUnits));
  });
});

describe('explicit EIP-1193 wallet choice and reviewed network addition', () => {
  it('lets the user select Rabby with MetaMask also present and pins its provider', async () => {
    const mm = wallet(); const rabby = wallet(); rabby.provider.isRabby = true;
    const page = browser({ ...mm.provider, providers: [rabby.provider, mm.provider] });
    const available = listEvmWallets(); expect(available[0]!.name).toBe('MetaMask');
    await connectEvm(available.find(item => item.name === 'Rabby')!.id); page.ethereum = mm.provider;
    expect(evmProvider()).toBe(rabby.provider); await getEvmChain();
    expect(mm.request).not.toHaveBeenCalled(); expect(rabby.request).toHaveBeenCalled();
  });
  it('discovers late EIP-6963 announcements without granting them connection permission', async () => {
    const page = browser(); expect(listEvmWallets()).toEqual([]); const w = wallet();
    page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask', name: 'MetaMask' }, provider: w.provider } }));
    expect(listEvmWallets()[0]!.name).toBe('MetaMask'); expect(w.request).not.toHaveBeenCalled();
    await connectEvm(listEvmWallets()[0]!.id); expect(evmProvider()).toBe(w.provider);
  });
  it('does not recursively request providers when the UI refreshes its list on an announcement', () => {
    const page = browser(); const w = wallet(); let requests = 0; let rendered: { id: string; name: string }[] = [];
    page.addEventListener('eip6963:requestProvider', () => {
      requests++;
      if (requests > 2) throw new Error('Recursive discovery');
      page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask', name: 'MetaMask' }, provider: w.provider } }));
    });
    page.addEventListener('eip6963:announceProvider', () => { rendered = listEvmWallets(); });
    const listed = listEvmWallets(); expect(requests).toBe(1); expect(listed).toHaveLength(1); expect(w.request).not.toHaveBeenCalled();
    // An earlier external listener can render before the discovery listener sees
    // this event. Its next refresh still sees the recorded provider, without a loop.
    rendered = listEvmWallets(); expect(rendered).toEqual(listed); expect(requests).toBe(1);
  });
  it('keeps discovery passive for asynchronously announced providers too', async () => {
    const page = browser(); const w = wallet(); let requests = 0;
    page.addEventListener('eip6963:requestProvider', () => {
      requests++;
      if (requests > 2) throw new Error('Async discovery loop');
      queueMicrotask(() => page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask', name: 'MetaMask' }, provider: w.provider } })));
    });
    page.addEventListener('eip6963:announceProvider', () => listEvmWallets());
    expect(listEvmWallets()).toEqual([]); await Promise.resolve(); await Promise.resolve();
    expect(listEvmWallets()).toHaveLength(1); expect(requests).toBe(1);
  });
  it('does not fall back after an unknown wallet id or rejected explicit connection', async () => {
    const mm = wallet(); const rabby = wallet(); rabby.provider.isRabby = true; browser({ ...mm.provider, providers: [mm.provider, rabby.provider] });
    await connectEvm(listEvmWallets()[0]!.id); const selected = evmProvider();
    await expect(connectEvm('not-discovered')).rejects.toThrow(/所选钱包/);
    rabby.state.connectError = { code: 4001, message: 'User rejected' };
    await expect(connectEvm(listEvmWallets().find(item => item.name === 'Rabby')!.id)).rejects.toMatchObject({ code: 4001 });
    expect(evmProvider()).toBe(selected);
  });
  it('adds an unknown reviewed chain only with pinned public metadata then verifies the result', async () => {
    const entry = REVIEWED_EVM_SOURCES.find(e => e.route.sourceChainId === 56)!; const w = wallet(); browser(w.provider); w.state.unknownChain = true;
    await switchEvmChain(56);
    expect(w.added).toEqual([{ chainId: '0x38', chainName: entry.route.sourceChain, nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: [entry.publicRpcUrl], blockExplorerUrls: [entry.explorerUrl] }]);
    expect(await getEvmChain()).toBe(56); expect(w.sent).toHaveLength(0);
  });
  it('refuses unreviewed chains and detects a wallet that did not switch', async () => {
    const w = wallet(); browser(w.provider);
    await expect(switchEvmChain(999999)).rejects.toThrow(/审核/); expect(w.request).not.toHaveBeenCalled();
    w.state.switchWrong = true; await expect(switchEvmChain(56)).rejects.toThrow(/尚未切换/); expect(w.added).toHaveLength(0);
  });
  it.each(['0x1garbage', '1', '0x01'])('does not accept malformed network quantity %s', async chain => {
    const w = wallet(); browser(w.provider); w.state.chain = chain;
    await expect(getEvmChain()).rejects.toThrow(/网络编号/);
  });
});
