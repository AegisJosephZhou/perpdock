/** Isolated EIP-1193 tests. Production wallet/payment functions and viem ABI
 * encoding execute; only the injected wallet RPC, API and storage are test doubles. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, erc20Abi, toHex, type Hex } from 'viem';
import { approveExact, connectEvm, depositAbi, evmProvider, getAllowance, getEvmChain, sendPayment, sourceBalance, switchEvmChain, validateQuoteContext, type BrowserProvider } from '../client/wallets.js';
import { api, persistSavedOrder, savedOrderForPayment, type SavedOrder } from '../client/api.js';
import { executeOrderPayment } from '../client/payment.js';
import type { Order, Quote, Route } from '../shared/types.js';

const source = '0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e';
const token = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const depository = '0x4cd00e387622c35bddb9b4c962c136462338bc31';
const protocolOrderId = '0xd8562d316bbec93d03d84c2b40494f5f3660c94ae0af71720e8414a859103641';
// Public Relay 2026-10-12 quote snapshot, not a signed transaction.
const realDepositData = '0xe8017952000000000000000000000000f3d63166f0ca56c3c1a3508fce03ff0cf3fb691e000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec70000000000000000000000000000000000000000000000000000000005f5e100d8562d316bbec93d03d84c2b40494f5f3660c94ae0af71720e8414a859103641';
const route: Route = { id: 'ethereum-usdt-hypercore', label: 'Ethereum USDT', sourceChain: 'Ethereum', sourceChainId: 1, sourceToken: token, symbol: 'USDT', decimals: 6, walletType: 'evm', available: true };
const quote = (): Quote => ({ id: 'ethereum-wallet-quote', routeId: route.id, sourceAddress: source, recipient: source, protocolOrderId, amount: '100', amountBaseUnits: '100000000', expectedReceive: '99.837994', minReceive: '98.839614', expiresAt: new Date(Date.now() + 120_000).toISOString(), provider: 'Relay', fees: [], warnings: [], approval: { token, spender: depository, amount: '100000000' }, transaction: { kind: 'evm', chainId: 1, to: depository, data: realDepositData, value: '0' } });
type Sent = { from: string; to: string; data: Hex; value: string; chainId: string };
function provider(initialAllowance = 100000000n) {
  const state = { account: source, chain: '0x1', allowance: initialAllowance, balance: 234567891n, reverted: false, badReceipt: false, receiptPatch: {} as Record<string, unknown>, hashResponse: undefined as string | undefined, sendError: undefined as unknown, afterCall: undefined as (() => void) | undefined, onSend: undefined as ((tx: Sent) => void) | undefined };
  const sent: Sent[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: any }) => {
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [state.account];
    if (method === 'eth_chainId') return state.chain;
    if (method === 'eth_getBalance') return toHex(10n ** 18n);
    if (method === 'eth_estimateGas') return toHex(100000n);
    if (method === 'eth_gasPrice') return toHex(1000000000n);
    if (method === 'wallet_switchEthereumChain') { state.chain = params[0].chainId; return null; }
    if (method === 'eth_call') {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: params[0].data });
      const value = decoded.functionName === 'allowance' ? state.allowance : state.balance;
      state.afterCall?.(); return toHex(value, { size: 32 });
    }
    if (method === 'eth_sendTransaction') {
      const tx = structuredClone(params[0]); sent.push(tx); state.onSend?.(tx);
      if (state.sendError) throw state.sendError;
      return state.hashResponse ?? toHex(sent.length, { size: 32 });
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = params[0]; const tx = sent[Number(BigInt(hash)) - 1]!;
      if (!tx) throw new Error('Unexpected receipt hash in isolated test');
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (!state.reverted && decoded.functionName === 'approve') state.allowance = decoded.args[1];
      return { transactionHash: state.badReceipt ? `0x${'ff'.repeat(32)}` : hash, from: tx.from, to: tx.to, blockNumber: '0x64', blockHash: toHex(100, { size: 32 }), status: state.reverted ? '0x0' : '0x1', ...state.receiptPatch };
    }
    throw new Error(`Unexpected isolated wallet method ${method}`);
  });
  return { state, sent, request, provider: { isMetaMask: true, request } as BrowserProvider };
}
function browser(ethereum?: BrowserProvider) {
  const target = new EventTarget();
  const value = { ethereum, addEventListener: target.addEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target), removeEventListener: target.removeEventListener.bind(target) };
  vi.stubGlobal('window', value);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No network permitted in isolated EVM wallet tests'); }));
  return value;
}
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
function recovery(q: Quote) {
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, action: (lock: object) => unknown) => action({}) } });
  const at = new Date().toISOString();
  const saved: SavedOrder = { id: 'ethereum-recovery', accessToken: 'test-only-token', createdAt: at };
  const order: Order = { id: saved.id, quote: q, status: 'awaiting_signature', statusMessage: '', createdAt: at, updatedAt: at, events: [] };
  persistSavedOrder(saved); vi.spyOn(api, 'order').mockResolvedValue(order); vi.spyOn(api, 'report').mockResolvedValue(order);
  return { saved, flow: { saved, expectedQuoteId: q.id, validate: (current: Quote) => validateQuoteContext(current, route, source, source), sign: (current: Quote, onHash: (hash: string) => void) => sendPayment(current, route, onHash), onSaved: vi.fn(), onOrder: vi.fn(), onProgress: vi.fn() } };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Ethereum USDT wallet execution', () => {
  it('prefers MetaMask over Rabby compatibility flags and pins all reads and sends to the connected provider', async () => {
    const mm = provider(); const rabby = provider(); rabby.provider.isRabby = true;
    const page = browser({ ...rabby.provider, providers: [rabby.provider, mm.provider] });
    expect(await connectEvm()).toBe(source); page.ethereum = rabby.provider;
    expect(evmProvider()).toBe(mm.provider); expect(await getEvmChain()).toBe(1);
    expect(await sourceBalance(route, source)).toBe('234.567891');
    await switchEvmChain(1); await sendPayment(quote(), route, vi.fn());
    expect(rabby.request).not.toHaveBeenCalled(); expect(mm.sent).toHaveLength(1);
  });
  it('uses the EIP-6963 MetaMask provider instead of a competing legacy injection', async () => {
    const mm = provider(); const other = provider(); const page = browser(other.provider);
    page.addEventListener('eip6963:requestProvider', () => page.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns: 'io.metamask' }, provider: mm.provider } })));
    await connectEvm(); await sendPayment(quote(), route, vi.fn());
    expect(other.request).not.toHaveBeenCalled(); expect(mm.sent).toHaveLength(1);
  });
  it('resets nonzero insufficient allowance, waits for receipt, then grants only the exact amount', async () => {
    const w = provider(7n); browser(w.provider); await connectEvm();
    await approveExact(quote(), route, vi.fn());
    expect(w.sent.map(tx => decodeFunctionData({ abi: erc20Abi, data: tx.data }).args?.[1])).toEqual([0n, 100000000n]);
    expect(w.sent.every(tx => tx.to === token && tx.from === source && tx.chainId === '0x1' && tx.value === '0x0')).toBe(true);
    expect(w.request.mock.calls.filter(([input]) => input.method === 'eth_getTransactionReceipt')).toHaveLength(2);
    expect(w.state.allowance).toBe(100000000n);
  });
  it('does not add a reset when allowance is zero and does not approve when enough allowance exists', async () => {
    const w = provider(0n); browser(w.provider); await approveExact(quote(), route, vi.fn());
    expect(w.sent).toHaveLength(1); await approveExact(quote(), route, vi.fn()); expect(w.sent).toHaveLength(1);
  });
  it.each(['reverted', 'wrong-receipt'] as const)('stops after the reset when its receipt is %s', async kind => {
    const w = provider(1n); w.state.reverted = kind === 'reverted'; w.state.badReceipt = kind === 'wrong-receipt'; browser(w.provider);
    await expect(approveExact(quote(), route, vi.fn())).rejects.toThrow(/授权/); expect(w.sent).toHaveLength(1);
  });
  it.each([
    ['missing block number', { blockNumber: undefined }], ['pending block number', { blockNumber: null }],
    ['decimal block number', { blockNumber: '100' }], ['noncanonical block number', { blockNumber: '0x064' }],
    ['missing block hash', { blockHash: undefined }], ['malformed block hash', { blockHash: '0x64' }],
    ['nonstring transaction hash', { transactionHash: 1 }], ['nonstring payer', { from: 1 }], ['missing token', { to: undefined }],
  ])('stops the approval sequence on a malformed receipt: %s', async (_kind, patch) => {
    const w = provider(1n); w.state.receiptPatch = patch as Record<string, unknown>; browser(w.provider);
    await expect(approveExact(quote(), route, vi.fn())).rejects.toThrow(/授权凭证/); expect(w.sent).toHaveLength(1);
  });
  it('does not retry an explicitly rejected approval', async () => {
    const w = provider(1n); w.state.sendError = { code: 4001, message: 'User rejected' }; browser(w.provider);
    await expect(approveExact(quote(), route, vi.fn())).rejects.toMatchObject({ code: 4001 }); expect(w.sent).toHaveLength(1);
  });
  it('stops the approval sequence if the wallet switches chain after the reset transaction', async () => {
    const w = provider(1n); browser(w.provider); w.state.onSend = () => { w.state.chain = '0xa4b1'; };
    await expect(approveExact(quote(), route, vi.fn())).rejects.toThrow(/切换到/); expect(w.sent).toHaveLength(1);
  });
  it.each(['spender', 'to', 'token', 'value', 'chain', 'payer', 'amount', 'protocolId', 'missingId', 'requestId', 'extraData', 'displayAmount'] as const)('rejects a quote with altered %s before asking for a transaction', async kind => {
    const w = provider(); browser(w.provider); const q = quote(); if (q.transaction.kind !== 'evm') throw new Error('fixture');
    if (kind === 'spender') q.approval!.spender = source;
    if (kind === 'to') q.transaction.to = source;
    if (kind === 'token') q.approval!.token = source;
    if (kind === 'value') q.transaction.value = '1';
    if (kind === 'chain') q.transaction.chainId = 42161;
    if (kind === 'missingId') delete q.protocolOrderId;
    if (kind === 'protocolId') q.protocolOrderId = `0x${'ff'.repeat(32)}`;
    if (kind === 'requestId') q.protocolOrderId = '0x1791844500f9e2c8b689adafbeb296fff62516635561ad6a0b3ee7f5af608059';
    if (kind === 'extraData') q.transaction.data += '00';
    if (kind === 'displayAmount') q.amount = '101';
    if (kind === 'payer' || kind === 'amount') q.transaction.data = encodeFunctionData({ abi: depositAbi, functionName: 'depositErc20', args: [kind === 'payer' ? depository : source, token, kind === 'amount' ? 1n : 100000000n, protocolOrderId] });
    await expect(sendPayment(q, route, vi.fn())).rejects.toThrow(); await expect(approveExact(q, route, vi.fn())).rejects.toThrow(); expect(w.sent).toHaveLength(0);
  });
  it.each(['account', 'chain', 'expiry'] as const)('rechecks %s after asynchronous allowance read before payment', async kind => {
    const w = provider(); browser(w.provider); const q = quote();
    w.state.afterCall = () => { if (kind === 'account') w.state.account = depository; if (kind === 'chain') w.state.chain = '0xa4b1'; if (kind === 'expiry') q.expiresAt = '2000-01-01T00:00:00.000Z'; };
    await expect(sendPayment(q, route, vi.fn())).rejects.toThrow(); expect(w.sent).toHaveLength(0);
  });
  it('sends exactly the reviewed deposit and saves hash before any post-send RPC, even if quote expires in the wallet prompt', async () => {
    const w = provider(); browser(w.provider); const q = quote(); const order: string[] = [];
    w.state.onSend = () => { order.push('send'); q.expiresAt = '2000-01-01T00:00:00.000Z'; };
    const hash = await sendPayment(q, route, () => { order.push('persist'); expect(w.request.mock.calls.at(-1)?.[0].method).toBe('eth_sendTransaction'); });
    expect(order).toEqual(['send', 'persist']); expect(hash).toBe(toHex(1, { size: 32 }));
    expect(w.sent).toEqual([{ from: source, to: depository, data: realDepositData, value: '0x0', chainId: '0x1' }]);
  });
  it('preserves an unknown lock without automatic retries when eth_sendTransaction times out', async () => {
    const w = provider(); browser(w.provider); w.state.sendError = new Error('Wallet transport timeout'); const r = recovery(quote());
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(/付款结果尚不确定/);
    expect(savedOrderForPayment(r.saved.id)?.submission).toEqual({ state: 'unknown' });
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(/已有付款操作记录/); expect(w.sent).toHaveLength(1); expect(api.report).not.toHaveBeenCalled();
  });
  it('keeps a returned EVM hash after report failure and never pays the recovered order again', async () => {
    const w = provider(); browser(w.provider); const r = recovery(quote()); vi.mocked(api.report).mockRejectedValue(new Error('Report unavailable'));
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(/交易编号已保留/);
    expect(savedOrderForPayment(r.saved.id)?.submission).toEqual({ state: 'unknown', txHash: toHex(1, { size: 32 }) });
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(/已有付款操作记录/); expect(w.sent).toHaveLength(1);
  });
  it('clears only an explicit pre-broadcast rejection and permits a later payment', async () => {
    const w = provider(); browser(w.provider); const r = recovery(quote()); w.state.sendError = { code: 4001, message: 'User rejected' };
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(); expect(savedOrderForPayment(r.saved.id)?.submission).toBeUndefined();
    w.state.sendError = undefined; await executeOrderPayment(r.flow); expect(w.sent).toHaveLength(2);
  });
  it('treats an invalid hash response as unknown instead of reporting it or retrying the send', async () => {
    const w = provider(); browser(w.provider); const r = recovery(quote()); w.state.hashResponse = 'not-a-hash';
    await expect(executeOrderPayment(r.flow)).rejects.toThrow(/未返回有效交易编号/);
    expect(savedOrderForPayment(r.saved.id)?.submission).toEqual({ state: 'unknown' });
    expect(w.sent).toHaveLength(1); expect(api.report).not.toHaveBeenCalled();
  });
  it('blocks payment if allowance was revoked and approval metadata is absent', async () => {
    const w = provider(0n); browser(w.provider); const q = quote(); delete q.approval;
    expect(await getAllowance(q, route)).toBe(0n); await expect(sendPayment(q, route, vi.fn())).rejects.toThrow(/额度不足/); expect(w.sent).toHaveLength(0);
  });
});
