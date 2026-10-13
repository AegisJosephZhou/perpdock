/** Isolated wallet tests: real TronWeb encoding/protobuf; no browser injection,
 * no private keys, and no real signing, node requests or broadcast. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TronWeb, utils } from 'tronweb';
import { decodeFunctionData, erc20Abi, toFunctionSelector, type Hex } from 'viem';
import { approveExact, getAllowance, isWalletRejection, sendPayment } from '../client/wallets.js';
import type { Quote, Route } from '../shared/types.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/relay-tron-quote.json', import.meta.url), 'utf8'));
const source: string = raw.details.sender;
const depository = 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN';
const token = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const route: Route = { id: 'tron-usdt-hypercore', label: 'Tron USDT', sourceChain: 'Tron', sourceChainId: 728126428,
  sourceToken: token, symbol: 'USDT', decimals: 6, walletType: 'tron', available: true };
const quote = (): Quote => ({ id: 'test-wallet-quote', routeId: route.id, sourceAddress: source, recipient: raw.details.recipient,
  amount: '100', amountBaseUnits: '100000000', expectedReceive: '99', minReceive: '98',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), provider: 'Relay', fees: [], warnings: [],
  approval: { token, spender: depository, amount: '100000000' },
  transaction: { kind: 'tron', transaction: structuredClone(raw.steps[1].items[0].data), contractAddress: depository } });

// Test-only node response generator. The real TronWeb trigger builder ABI-encodes
// its parameters and then validates this response with its official protobuf code.
function nodeTransaction(args: any) {
  const tx: any = { visible: false, txID: '', raw_data_hex: '', raw_data: {
    contract: [{ type: 'TriggerSmartContract', parameter: {
      type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: {
        owner_address: args.owner_address, contract_address: args.contract_address,
        data: toFunctionSelector(args.function_selector).slice(2) + args.parameter,
      },
    } }],
    ref_block_bytes: '1234', ref_block_hash: '1122334455667788', expiration: 1791831850000,
    timestamp: 1791831790000, fee_limit: args.fee_limit,
  } };
  refreshEncoding(tx);
  return tx;
}
function refreshEncoding(tx: any) {
  const pb = utils.transaction.txJsonToPb(tx);
  tx.raw_data_hex = utils.transaction.txPbToRawDataHex(pb).toLowerCase();
  tx.txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '').toLowerCase();
}
function wallet(allowance = 100000000n) {
  const tron = new TronWeb({ fullHost: 'https://api.trongrid.io' });
  tron.setAddress(source);
  const allowanceCall = vi.fn(async () => allowance);
  vi.spyOn(tron, 'contract').mockImplementation(() => ({ at: async () => ({ allowance: () => ({ call: allowanceCall }) }) }) as any);
  const node = vi.spyOn(tron.fullNode, 'request').mockImplementation(async (path, args) => {
    if (path !== 'wallet/triggersmartcontract') throw new Error(`Unexpected test RPC ${path}`);
    return { result: { result: true }, transaction: nodeTransaction(args) };
  });
  const sign = vi.spyOn(tron.trx, 'sign').mockImplementation(async (tx: any) => ({ ...tx, signature: ['ab'.repeat(65)] }) as any);
  const broadcast = vi.spyOn(tron.trx, 'sendRawTransaction').mockImplementation(async (tx: any) => ({ result: true, txid: tx.txID }) as any);
  vi.spyOn(tron.trx, 'getTransactionInfo').mockResolvedValue({ blockNumber: 999, receipt: { result: 'SUCCESS' } } as any);
  vi.stubGlobal('window', { tronLink: { request: vi.fn() }, tronWeb: tron });
  // Any unmocked transport is a test failure, not a fallback to real networking.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network in isolated wallet test'); }));
  return { tron, node, sign, broadcast, allowanceCall };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('TronLink execution integrity with TronWeb 6.5.1', () => {
  it('builds exact depositErc20 calldata using the actual TronWeb encoder and persists hash before broadcast', async () => {
    const w = wallet(); const q = quote(); const order: string[] = [];
    w.broadcast.mockImplementation(async (tx: any) => { order.push('broadcast'); return { result: true, txid: tx.txID } as any; });
    const hash = await sendPayment(q, route, (id) => { expect(id).toMatch(/^[a-f\d]{64}$/); order.push('persist'); });
    expect(order).toEqual(['persist', 'broadcast']);
    expect(w.node).toHaveBeenCalledTimes(1); expect(w.sign).toHaveBeenCalledTimes(1);
    const signed = w.sign.mock.calls[0]![0] as any;
    expect(signed.raw_data.contract[0].parameter.value.data).toBe(raw.steps[1].items[0].data.parameter.data);
    expect(signed.raw_data.fee_limit).toBe(150000000);
    expect(utils.transaction.txCheck(signed)).toBe(true); expect(hash).toBe(signed.txID);
  });
  it('resets nonzero insufficient USDT allowance and then approves exactly the required amount', async () => {
    const w = wallet(1n);
    await approveExact(quote(), route, vi.fn());
    const amounts = w.sign.mock.calls.map(([tx]) => decodeFunctionData({ abi: erc20Abi, data: `0x${(tx as any).raw_data.contract[0].parameter.value.data}` as Hex }).args![1]);
    expect(amounts).toEqual([0n, 100000000n]); expect(w.broadcast).toHaveBeenCalledTimes(2);
  });
  it('P2-1 reads actual allowance when Relay omitted approval and blocks revoked allowance before building or signing', async () => {
    const w = wallet(0n); const q = quote(); delete q.approval;
    expect(await getAllowance(q, route)).toBe(0n);
    await expect(sendPayment(q, route, vi.fn())).rejects.toThrow(/授权额度不足/);
    await expect(approveExact(q, route, vi.fn())).rejects.toThrow(/重新获取/);
    expect(w.allowanceCall).toHaveBeenCalled(); expect(w.node).not.toHaveBeenCalled(); expect(w.sign).not.toHaveBeenCalled();
  });
  it('handles official TronLink rejection with no code and never broadcasts or persists a hash', async () => {
    const w = wallet(); const rejected = new Error('Confirmation declined by user'); const persist = vi.fn();
    w.sign.mockRejectedValue(rejected);
    await expect(sendPayment(quote(), route, persist)).rejects.toBe(rejected);
    expect(isWalletRejection(rejected)).toBe(true); expect(w.broadcast).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('blocks a changed account after transaction construction, before signing', async () => {
    const w = wallet();
    w.node.mockImplementation(async (_path, args) => {
      const tx = nodeTransaction(args); w.tron.setAddress(depository);
      return { result: { result: true }, transaction: tx };
    });
    await expect(sendPayment(quote(), route, vi.fn())).rejects.toThrow(/账户已变化/);
    expect(w.sign).not.toHaveBeenCalled();
  });
  it('blocks expiry while the signing prompt is open, without persisting or broadcasting', async () => {
    const w = wallet(); const q = quote(); const persist = vi.fn();
    w.sign.mockImplementation(async (tx: any) => { q.expiresAt = new Date(Date.now() - 1).toISOString(); return { ...tx, signature: ['ab'.repeat(65)] } as any; });
    await expect(sendPayment(q, route, persist)).rejects.toThrow(/到期/);
    expect(w.broadcast).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it.each(['data', 'rawHex', 'fee', 'TRC10', 'permission', 'secondContract'] as const)('rejects %s tampering by a signer, including mutation of the same transaction object', async (kind) => {
    const w = wallet(); const persist = vi.fn();
    w.sign.mockImplementation(async (tx: any) => {
      if (kind === 'data') tx.raw_data.contract[0].parameter.value.data = 'a9059cbb' + '00'.repeat(64);
      if (kind === 'rawHex') tx.raw_data_hex += '00';
      if (kind === 'fee') tx.raw_data.fee_limit = 150000001;
      if (kind === 'TRC10') tx.raw_data.contract[0].parameter.value.call_token_value = 1;
      if (kind === 'permission') tx.raw_data.contract[0].Permission_id = 2;
      if (kind === 'secondContract') tx.raw_data.contract.push(structuredClone(tx.raw_data.contract[0]));
      tx.signature = ['ab'.repeat(65)]; return tx;
    });
    await expect(sendPayment(quote(), route, persist)).rejects.toThrow(/阻止/);
    expect(w.broadcast).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  });
  it('rejects a freshly rehashed modified transaction despite internally consistent protobuf', async () => {
    const w = wallet();
    w.sign.mockImplementation(async (tx: any) => { tx.raw_data.timestamp += 1; refreshEncoding(tx); tx.signature = ['ab'.repeat(65)]; expect(utils.transaction.txCheck(tx)).toBe(true); return tx; });
    await expect(sendPayment(quote(), route, vi.fn())).rejects.toThrow(/内容被改变/);
    expect(w.broadcast).not.toHaveBeenCalled();
  });
  it('blocks broadcast when durable hash persistence fails', async () => {
    const w = wallet();
    await expect(sendPayment(quote(), route, () => { throw new Error('storage unavailable'); })).rejects.toThrow('storage unavailable');
    expect(w.sign).toHaveBeenCalledTimes(1); expect(w.broadcast).not.toHaveBeenCalled();
  });
  it('retains the submitted hash on a broadcast error and does not automatically retry', async () => {
    const w = wallet(); const persist = vi.fn();
    w.broadcast.mockResolvedValue({ result: false, code: 'SERVER_BUSY' } as any);
    await expect(sendPayment(quote(), route, persist)).rejects.toThrow(/不要再次付款/);
    expect(persist).toHaveBeenCalledTimes(1); expect(w.broadcast).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0]).toBe((w.sign.mock.calls[0]![0] as any).txID);
  });
  it('rejects an incorrect node-generated raw encoding before signing', async () => {
    const w = wallet();
    w.node.mockImplementation(async (_path, args) => { const tx = nodeTransaction(args); tx.raw_data_hex += '00'; return { result: { result: true }, transaction: tx }; });
    await expect(sendPayment(quote(), route, vi.fn())).rejects.toThrow('Invalid transaction');
    expect(w.sign).not.toHaveBeenCalled(); expect(w.broadcast).not.toHaveBeenCalled();
  });
});
