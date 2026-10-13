import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrderId as officialOrderId } from '@relay-protocol/settlement-sdk';
import { encodeFunctionData, parseAbi } from 'viem';
import { validateRelayQuote, trackOrder, verifySourceTransaction } from '../server/providers/relay.js';
import { getOrderId, type RelayOrder } from '../server/providers/order-hash.js';
import * as ethereum from '../server/chain/ethereum.js';
import * as tron from '../server/chain/tron.js';
import type { StoredQuote, TrackedOrder } from '../shared/types.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const raw = () => fixture('relay-ethereum-quote.json');
const canonical = fixture('relay-ethereum-chains.json').chains;
const input = { routeId: 'ethereum-usdt-hypercore', amount: '100', sourceAddress: raw().details.sender, recipient: raw().details.recipient };
const now = 1791844501000;
const validated = async (): Promise<StoredQuote> => ({ ...await validateRelayQuote(raw(), input, canonical, now), id: 'ethereum-test-quote' });
const deposit = (q: any) => q.steps.find((s: any) => s.id === 'deposit').items[0].data;
const approval = (q: any) => q.steps.find((s: any) => s.id === 'approve').items[0].data;
const other = '0x1111111111111111111111111111111111111111';
const response = (body: unknown) => new Response(JSON.stringify(body));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('captured Ethereum mainnet Relay order', () => {
  it('verifies the real signed quote and emits only reviewed transaction fields', async () => {
    const quote = await validated();
    expect(quote.protocolOrderId).toBe(raw().protocol.v2.orderId);
    expect(quote.protocolOrderId).not.toBe(raw().requestId);
    expect(quote.minReceive).toBe('98.839614');
    expect(quote.expectedReceive).toBe('99.837994');
    expect(quote.transaction).toEqual({ kind: 'evm', chainId: 1, to: ethereum.ETHEREUM_DEPOSITORY, data: deposit(raw()).data, value: '0' });
    expect(quote.approval).toEqual({ token: ethereum.ETHEREUM_USDT.toLowerCase(), spender: ethereum.ETHEREUM_DEPOSITORY, amount: '100000000' });
    expect(quote.estimatedSeconds).toBeUndefined();
    expect(quote.warnings.join(' ')).toContain('15分钟');
    const order = raw().protocol.v2.orderData as RelayOrder;
    const vms = { ethereum: 'ethereum-vm', hyperliquid: 'hyperliquid-vm', base: 'ethereum-vm' } as const;
    expect(getOrderId(order, vms)).toBe(officialOrderId(order as Parameters<typeof officialOrderId>[0], vms));
    expect(getOrderId(order, vms)).toBe(quote.protocolOrderId);
  });
  it('accepts address case differences and still exposes exact allowance metadata without approve step', async () => {
    const q = raw(); q.steps = q.steps.filter((s: any) => s.id !== 'approve');
    const quote = await validateRelayQuote(q, { ...input, sourceAddress: input.sourceAddress.toUpperCase().replace('0X', '0x') }, canonical, now);
    expect(quote.approval?.amount).toBe('100000000');
  });
  const mutations: [string, (q: any) => void][] = [
    ['wrong chain', q => { deposit(q).chainId = 42161; }],
    ['wrong payer', q => { deposit(q).from = other; }],
    ['wrong depository', q => { deposit(q).to = other; }],
    ['native value', q => { deposit(q).value = '1'; }],
    ['extra calldata', q => { deposit(q).data += '00'; }],
    ['wrong protocol id in calldata', q => { deposit(q).data = deposit(q).data.slice(0, -64) + '11'.repeat(32); }],
    ['wrong calldata payer', q => { deposit(q).data = '0xe8017952' + other.slice(2).padStart(64, '0') + deposit(q).data.slice(74); }],
    ['wrong deposit token', q => { deposit(q).data = deposit(q).data.slice(0, 74) + other.slice(2).padStart(64, '0') + deposit(q).data.slice(138); }],
    ['wrong deposit amount', q => { deposit(q).data = deposit(q).data.slice(0, 138) + '1'.padStart(64, '0') + deposit(q).data.slice(202); }],
    ['unknown wallet authorization', q => { deposit(q).authorizationList = []; }],
    ['unbounded approval', q => { approval(q).data = approval(q).data.slice(0, -64) + 'f'.repeat(64); }],
    ['wrong approval spender', q => { approval(q).data = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [other, 100000000n] }); }],
    ['approval from other account', q => { approval(q).from = other; }],
    ['native approval', q => { approval(q).value = '1'; }],
    ['mismatched requestId', q => { q.steps[0].requestId = '0x' + '22'.repeat(32); }],
    ['unknown signing step', q => { q.steps[0].id = 'permit'; }],
    ['wrong refund recipient', q => { q.protocol.v2.orderData.inputs[0].refunds[0].recipient = other; }],
    ['unknown output calls', q => { q.protocol.v2.orderData.output.calls = ['0x']; }],
    ['minimum and display tampering', q => { q.protocol.v2.orderData.output.payments[0].minimumAmount = '1'; q.details.currencyOut.minimumAmount = '1'; }],
    ['bad signature', q => { q.protocol.v2.orderSignature = '0x' + '11'.repeat(65); }],
    ['wrong solver', q => { q.protocol.v2.orderData.solver = other; }],
    ['untrusted payment details', q => { q.protocol.v2.paymentDetails.depository = other; }],
    ['wrong input precision', q => { q.details.currencyIn.currency.decimals = 18; }],
  ];
  it.each(mutations)('rejects %s', async (_name, mutate) => {
    const q = raw(); mutate(q); await expect(validateRelayQuote(q, input, canonical, now)).rejects.toThrow();
  });
  it('rejects an independently changed registry and deadline expiry', async () => {
    const chains = structuredClone(canonical); chains.find((c: any) => c.id === 1).protocol.v2.depository = other;
    await expect(validateRelayQuote(raw(), input, chains, now)).rejects.toThrow('depository');
    await expect(validateRelayQuote(raw(), input, canonical, raw().protocol.v2.orderData.output.deadline * 1000)).rejects.toThrow('期限');
  });
});

// Synthetic RPC observations are isolated here; the signed protocol quote above is a real public snapshot.
const txHash = '0x' + '33'.repeat(32);
const blockHash = '0x' + '44'.repeat(32);
const fillHash = '0x' + '55'.repeat(32);
async function sourceSetup() {
  const quote = await validated();
  const tx = { hash: txHash, from: input.sourceAddress, to: ethereum.ETHEREUM_DEPOSITORY, input: deposit(raw()).data, value: '0x0', chainId: '0x1', blockHash, blockNumber: '0x100' };
  const receipt = { transactionHash: txHash, from: input.sourceAddress, to: ethereum.ETHEREUM_DEPOSITORY, status: '0x1', blockHash, blockNumber: '0x100', logs: [{ address: ethereum.ETHEREUM_USDT, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${input.sourceAddress.slice(2).padStart(64, '0')}`, `0x${ethereum.ETHEREUM_DEPOSITORY.slice(2).padStart(64, '0')}`], data: `0x${100000000n.toString(16).padStart(64, '0')}`, transactionHash: txHash, blockHash, blockNumber: '0x100', removed: false }] };
  const observations: any = { chainId: '0x1', tx, receipt, finalized: { number: '0x110', hash: '0x' + '66'.repeat(32), transactions: [] }, canonical: { number: '0x100', hash: blockHash, transactions: [txHash] } };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    const result = request.method === 'eth_chainId' ? observations.chainId : request.method === 'eth_getTransactionByHash' ? observations.tx : request.method === 'eth_getTransactionReceipt' ? observations.receipt : request.method === 'eth_getBlockByNumber' ? observations[request.params[0] === 'finalized' ? 'finalized' : 'canonical'] : undefined;
    return response({ jsonrpc: '2.0', id: 1, result });
  }));
  return { quote, observations };
}

describe('Ethereum finalized payment verification', () => {
  it('requires exact successful transfer and canonical inclusion behind finalized head', async () => {
    const { quote } = await sourceSetup();
    expect(await ethereum.verifyEthereumSource(quote, txHash)).toMatchObject({ valid: true, pending: false });
    expect(vi.mocked(fetch).mock.calls.map(c => JSON.parse(String(c[1]?.body)).method)).toContain('eth_getBlockByNumber');
  });
  const bad: [string, (o: any) => void][] = [
    ['RPC network', o => { o.chainId = '0xa'; }], ['transaction network', o => { o.tx.chainId = '0xa'; }],
    ['transaction hash', o => { o.tx.hash = fillHash; }], ['payer', o => { o.tx.from = other; }],
    ['target', o => { o.tx.to = other; }], ['calldata', o => { o.tx.input += '00'; }], ['native ETH', o => { o.tx.value = '0x1'; }],
    ['reverted receipt', o => { o.receipt.status = '0x0'; }], ['receipt identity', o => { o.receipt.transactionHash = fillHash; }],
    ['receipt block', o => { o.receipt.blockHash = fillHash; }], ['receipt payer', o => { o.receipt.from = other; }],
    ['missing transfer', o => { o.receipt.logs = []; }], ['wrong token', o => { o.receipt.logs[0].address = other; }],
    ['wrong transfer amount', o => { o.receipt.logs[0].data = '0x' + '0'.repeat(63) + '1'; }],
    ['wrong transfer payer', o => { o.receipt.logs[0].topics[1] = '0x' + other.slice(2).padStart(64, '0'); }],
    ['wrong transfer recipient', o => { o.receipt.logs[0].topics[2] = '0x' + other.slice(2).padStart(64, '0'); }],
    ['removed transfer', o => { o.receipt.logs[0].removed = true; }], ['foreign log', o => { o.receipt.logs[0].transactionHash = fillHash; }],
    ['canonical reorg', o => { o.canonical.hash = fillHash; }], ['canonical number', o => { o.canonical.number = '0x101'; }],
    ['absent block transaction', o => { o.canonical.transactions = []; }],
    ['contradictory finality', o => { o.finalized = { number: '0x100', hash: fillHash, transactions: [txHash] }; }],
  ];
  it.each(bad)('does not accept %s', async (_name, mutate) => {
    const { quote, observations } = await sourceSetup(); mutate(observations);
    expect((await ethereum.verifyEthereumSource(quote, txHash)).valid).toBe(false);
  });
  it.each(['unseen', 'unmined', 'receipt', 'finality', 'finalityMissing', 'blockMissing'])('keeps %s payment pending', async state => {
    const { quote, observations: o } = await sourceSetup();
    if (state === 'unseen') o.tx = null;
    if (state === 'unmined') { o.tx.blockHash = null; o.tx.blockNumber = null; }
    if (state === 'receipt') o.receipt = null;
    if (state === 'finality') o.finalized.number = '0xff';
    if (state === 'finalityMissing') o.finalized = null;
    if (state === 'blockMissing') o.canonical = null;
    expect(await ethereum.verifyEthereumSource(quote, txHash)).toMatchObject({ valid: true, pending: true });
  });
  it('fails closed on RPC errors, absent result, bad JSON-RPC id and HTTP failure', async () => {
    const { quote } = await sourceSetup();
    for (const body of [{ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'private upstream error' } }, { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 2, result: '0x1' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => response(body)));
      await expect(ethereum.verifyEthereumSource(quote, txHash)).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    await expect(ethereum.verifyEthereumSource(quote, txHash)).rejects.toThrow();
  });
  it('does not query RPC for a wrong order or protocol binding', async () => {
    const { quote } = await sourceSetup(); quote.protocolOrderId = fillHash;
    expect((await ethereum.verifyEthereumSource(quote, txHash)).valid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses server HTTPS configuration and rejects URL credentials without echoing them', () => {
    vi.stubEnv('ETHEREUM_RPC_URL', 'https://operator.example/rpc'); expect(ethereum.ethereumRpcUrl()).toBe('https://operator.example/rpc');
    for (const value of ['http://operator.example', 'https://user:private@operator.example', 'https://operator.example#private']) {
      vi.stubEnv('ETHEREUM_RPC_URL', value); expect(() => ethereum.ethereumRpcUrl()).toThrow('HTTPS');
    }
  });
});

describe('dual route dispatch and unchanged HyperCore completion requirement', () => {
  async function order(): Promise<TrackedOrder> {
    const { providerData, ...quote } = await validated();
    return { id: 'ethereum-order', quote, providerData, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), sourceTxHash: txHash, status: 'source_pending', statusMessage: '', events: [] };
  }
  it('dispatches Ethereum and legacy Tron without treating one as the other', async () => {
    const eth = vi.spyOn(ethereum, 'verifyEthereumSource').mockResolvedValue({ valid: true, pending: true });
    const tr = vi.spyOn(tron, 'verifyTronSource').mockResolvedValue({ valid: true, pending: true });
    const quote = await validated(); await verifySourceTransaction(quote, txHash);
    expect(eth).toHaveBeenCalledOnce(); expect(tr).not.toHaveBeenCalled();
    const oldInput = { ...input, routeId: 'tron-usdt-hypercore', sourceAddress: fixture('relay-tron-quote.json').details.sender };
    const legacy = { ...await validateRelayQuote(fixture('relay-tron-quote.json'), oldInput, canonical, 1791831787228), id: 'old' };
    delete legacy.protocolOrderId;
    await verifySourceTransaction(legacy, '77'.repeat(32)); expect(tr).toHaveBeenCalledOnce();
  });
  it('does not query provider or ledger before finality', async () => {
    vi.spyOn(ethereum, 'verifyEthereumSource').mockResolvedValue({ valid: true, pending: true });
    vi.stubGlobal('fetch', vi.fn());
    expect((await trackOrder(await order())).status).toBe('source_pending'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects provider success for another origin chain and cannot complete without credit', async () => {
    vi.spyOn(ethereum, 'verifyEthereumSource').mockResolvedValue({ valid: true, pending: false });
    const current = await order();
    const status = { status: 'success', originChainId: 728126428, destinationChainId: 1337, inTxHashes: [txHash], txHashes: [fillHash] };
    vi.stubGlobal('fetch', vi.fn(async () => response(status)));
    expect((await trackOrder(current)).status).toBe('attention');
    status.originChainId = 1;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('status/v3') ? status : [])));
    expect((await trackOrder(current)).status).toBe('verifying_credit');
    vi.spyOn(Date, 'now').mockReturnValue(now + 60000);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('status/v3') ? status : [{ hash: fillHash, time: now + 1000, delta: { type: 'send', destination: input.recipient, destinationDex: '', token: 'USDC', amount: '99.8' } }])));
    const result = await trackOrder(current);
    expect(result.status).toBe('completed');
    expect(result.evidence).toContainEqual({ type: 'ethereum_finalized_transfer', reference: txHash });
    expect(result.evidence).toContainEqual({ type: 'hypercore_credit', reference: `${current.quote.recipient}:${fillHash}` });
  });
  it('keeps Tron available when only Ethereum registry or RPC configuration fails', async () => {
    vi.resetModules();
    const changed = structuredClone(canonical); changed.find((c: any) => c.id === 1).protocol.v2.depository = other;
    vi.stubGlobal('fetch', vi.fn(async () => response({ chains: changed })));
    let adapter = await import('../server/providers/relay.js');
    let routes = await adapter.getRoutes(); expect(routes.filter(r => ['ethereum-usdt-hypercore', 'tron-usdt-hypercore'].includes(r.id)).map(r => r.available)).toEqual([false, true]);
    vi.resetModules(); vi.stubEnv('ETHEREUM_RPC_URL', 'http://operator.example');
    vi.stubGlobal('fetch', vi.fn(async () => response({ chains: canonical })));
    adapter = await import('../server/providers/relay.js'); routes = await adapter.getRoutes();
    expect(routes.filter(r => ['ethereum-usdt-hypercore', 'tron-usdt-hypercore'].includes(r.id)).map(r => r.available)).toEqual([false, true]);
  });
});
