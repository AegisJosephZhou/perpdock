import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, parseAbi, parseUnits } from 'viem';
import { getOrderId as officialOrderId } from '@relay-protocol/settlement-sdk';
import { REVIEWED_EVM_SOURCES, type ReviewedEvmSource } from '../shared/route-registry.js';
import { validateRelayQuote, trackOrder, verifySourceTransaction } from '../server/providers/relay.js';
import * as evm from '../server/chain/evm.js';
import { evmRpcUrl } from '../server/chain/evm-rpc.js';
import type { StoredQuote, TrackedOrder } from '../shared/types.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/multichain/${name}`, import.meta.url), 'utf8'));
const canonical = fixture('chains.json').chains;
const now = 1791845100000;
const raw = (id: string) => fixture(`${id.replace('-hypercore', '')}-quote.json`);
const input = (id: string, amount = '10') => { const q = raw(id); return { routeId: id, amount, sourceAddress: q.details.sender, recipient: q.details.recipient }; };
const quote = async (id: string): Promise<StoredQuote> => ({ ...await validateRelayQuote(raw(id), input(id), canonical, now), id: `test-${id}` });
const txHash = '0x' + '33'.repeat(32);
const blockHash = '0x' + '44'.repeat(32);
const otherHash = '0x' + '55'.repeat(32);
const otherAddress = '0x1111111111111111111111111111111111111111';
const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const depositAbi = parseAbi(['function depositErc20(address depositor,address token,uint256 amount,bytes32 id)']);
const response = (value: unknown) => new Response(JSON.stringify(value));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('reviewed multichain live quotes', () => {
  it.each(REVIEWED_EVM_SOURCES.map(s => [s.route.id, s] as const))('validates real %s signature, exact input, canonical deposit and allowance', async (id, source) => {
    const q = await quote(id);
    const live = raw(id);
    const vms = Object.fromEntries(canonical.map((c: any) => [c.protocol.v2.chainId, c.vmType === 'hypevm' ? 'hyperliquid-vm' : c.vmType === 'tvm' ? 'tron-vm' : 'ethereum-vm']));
    expect(q.protocolOrderId).toBe(officialOrderId(live.protocol.v2.orderData, vms));
    expect(q.amountBaseUnits).toBe(parseUnits('10', source.route.decimals).toString());
    expect(q.transaction.kind).toBe('evm');
    if (q.transaction.kind !== 'evm') throw new Error('expected EVM');
    expect(q.transaction.chainId).toBe(source.route.sourceChainId);
    expect(q.transaction.to.toLowerCase()).toBe(source.depository);
    const call = decodeFunctionData({ abi: depositAbi, data: q.transaction.data as `0x${string}` });
    expect(call.args[1].toLowerCase()).toBe(source.route.sourceToken);
    expect(call.args[2]).toBe(BigInt(q.amountBaseUnits));
    expect(q.approval).toEqual({ token: source.route.sourceToken, spender: source.depository, amount: q.amountBaseUnits });
    expect(q.estimatedSeconds).toBeUndefined();
    expect(q.warnings.join(' ')).toContain(source.route.gasSymbol);
  });
  it('handles Polygon numeric gas metadata without forwarding it, including absent approval step', async () => {
    const id = 'polygon-usdc-hypercore';
    expect(typeof raw(id).steps[0].items[0].data.gas).toBe('number');
    const q = await quote(id); expect(q.transaction).not.toHaveProperty('gas'); expect(q.approval?.amount).toBe('10000000');
  });
  it.each(['approve', 'deposit'])('rejects noncanonical address padding in %s even when decoded arguments match', async step => {
    const id = 'bsc-usdt-hypercore'; const q = raw(id); const tx = q.steps.find((s: any) => s.id === step).items[0].data;
    tx.data = tx.data.slice(0, 10) + 'f' + tx.data.slice(11);
    await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow('规范 ABI');
  });
  it.each(REVIEWED_EVM_SOURCES.map(s => [s.route.id, s] as const))('rejects chain and token substitution for %s', async (id, source) => {
    const wrongChain = source.route.sourceChainId === 1 ? 56 : 1;
    let q = raw(id); q.steps.find((s: any) => s.id === 'deposit').items[0].data.chainId = wrongChain;
    await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow();
    q = raw(id); q.details.currencyIn.currency.address = otherAddress;
    await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow();
    q = raw(id); q.details.currencyIn.currency.decimals = source.route.decimals === 6 ? 18 : 6;
    await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow();
    q = raw(id); const approval = q.steps.find((s: any) => s.id === 'approve');
    if (approval) { approval.items[0].data.chainId = wrongChain; await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow(); }
  });
  it('keeps USDT0 and native USDC identities separate, rejecting unreviewed variants', async () => {
    expect(REVIEWED_EVM_SOURCES.find(s => s.route.id === 'arbitrum-usdt-hypercore')!.route.symbol).toBe('USDT0');
    for (const id of ['optimism-usdt-hypercore', 'base-usdt-hypercore', 'polygon-usdt-hypercore', 'arbitrum-usdce-hypercore']) {
      await expect(validateRelayQuote(raw('arbitrum-usdc-hypercore'), { ...input('arbitrum-usdc-hypercore'), routeId: id }, canonical, now)).rejects.toThrow('已审核');
    }
  });
  it('rejects a BSC six-decimal input, overprecision and unknown route even with a real signed quote', async () => {
    const id = 'bsc-usdt-hypercore'; const q = raw(id);
    q.details.currencyIn.amount = '10000000'; q.protocol.v2.orderData.inputs[0].payment.amount = '10000000';
    await expect(validateRelayQuote(q, input(id), canonical, now)).rejects.toThrow('金额');
    await expect(validateRelayQuote(raw(id), input(id, '10.0000000000000000001'), canonical, now)).rejects.toThrow('18');
    await expect(validateRelayQuote(raw('ethereum-usdt-hypercore'), input('ethereum-usdt-hypercore', '10.0000001'), canonical, now)).rejects.toThrow('6');
  });
});

async function sourceSetup(source: ReviewedEvmSource) {
  const q = await quote(source.route.id);
  if (q.transaction.kind !== 'evm') throw new Error('expected EVM');
  const tx = { hash: txHash, from: q.sourceAddress, to: source.depository, input: q.transaction.data, value: '0x0', chainId: `0x${source.route.sourceChainId.toString(16)}`, blockNumber: '0x100', blockHash };
  const log = { address: source.route.sourceToken, transactionHash: txHash, blockHash, blockNumber: '0x100', removed: false, topics: [transfer, `0x${q.sourceAddress.slice(2).toLowerCase().padStart(64, '0')}`, `0x${source.depository.slice(2).padStart(64, '0')}`], data: `0x${BigInt(q.amountBaseUnits).toString(16).padStart(64, '0')}` };
  const observation: any = { chainId: tx.chainId, tx, receipt: { transactionHash: txHash, from: q.sourceAddress, to: source.depository, status: '0x1', blockNumber: '0x100', blockHash, logs: [log] }, finalized: { number: '0x110', hash: otherHash, transactions: [] }, canonical: { number: '0x100', hash: blockHash, transactions: [txHash] } };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(source.publicRpcUrl.endsWith('/') ? source.publicRpcUrl : `${source.publicRpcUrl}/`);
    const body = JSON.parse(String(init.body));
    const result = body.method === 'eth_chainId' ? observation.chainId : body.method === 'eth_getTransactionByHash' ? observation.tx : body.method === 'eth_getTransactionReceipt' ? observation.receipt : observation[body.params[0] === 'finalized' ? 'finalized' : 'canonical'];
    return response({ jsonrpc: '2.0', id: 1, result });
  }));
  return { q, observation };
}

describe('per-chain exact source evidence', () => {
  it.each(REVIEWED_EVM_SOURCES.map(s => [s.route.id, s] as const))('verifies finalized %s and fails closed on wrong network/token/finality', async (_id, source) => {
    const { q, observation: o } = await sourceSetup(source);
    expect(await verifySourceTransaction(q, txHash)).toMatchObject({ valid: true, pending: false });
    const chainId = o.chainId; o.chainId = source.route.sourceChainId === 1 ? '0x38' : '0x1';
    expect((await evm.verifyEvmSource(q, txHash)).valid).toBe(false); o.chainId = chainId;
    const token = o.receipt.logs[0].address; o.receipt.logs[0].address = otherAddress;
    expect((await evm.verifyEvmSource(q, txHash)).valid).toBe(false); o.receipt.logs[0].address = token;
    const originalAmount = o.receipt.logs[0].data; o.receipt.logs[0].data = '0x' + '0'.repeat(63) + '1';
    expect((await evm.verifyEvmSource(q, txHash)).valid).toBe(false); o.receipt.logs[0].data = originalAmount;
    o.finalized.number = '0xff'; expect(await evm.verifyEvmSource(q, txHash)).toMatchObject({ valid: true, pending: true });
    o.finalized = null; expect(await evm.verifyEvmSource(q, txHash)).toMatchObject({ valid: true, pending: true });
  });
  it('binds BSC display amount to 18-decimal base units without integer precision loss', async () => {
    const source = REVIEWED_EVM_SOURCES.find(s => s.route.id === 'bsc-usdt-hypercore')!;
    const { q, observation: o } = await sourceSetup(source);
    const amount = '10.000000000000000001'; q.amount = amount; q.amountBaseUnits = '10000000000000000001';
    if (q.transaction.kind !== 'evm') throw new Error('expected EVM');
    q.transaction.data = encodeFunctionData({ abi: depositAbi, functionName: 'depositErc20', args: [q.sourceAddress as `0x${string}`, source.route.sourceToken as `0x${string}`, BigInt(q.amountBaseUnits), q.protocolOrderId as `0x${string}`] });
    o.tx.input = q.transaction.data; o.receipt.logs[0].data = '0x' + BigInt(q.amountBaseUnits).toString(16).padStart(64, '0');
    expect(await evm.verifyEvmSource(q, txHash)).toMatchObject({ valid: true, pending: false });
    q.amountBaseUnits = '10000000'; expect((await evm.verifyEvmSource(q, txHash)).valid).toBe(false);
  });
  it('tracks a new-chain order only with matching source, Relay origin, and default-Perps credit', async () => {
    const q = await quote('base-usdc-hypercore'); const { providerData, ...publicQuote } = q;
    const order: TrackedOrder = { id: 'base-order', quote: publicQuote, providerData, sourceTxHash: txHash, status: 'source_pending', statusMessage: '', events: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    vi.spyOn(evm, 'verifyEvmSource').mockResolvedValue({ valid: true, pending: false });
    const status = { status: 'success', originChainId: 1, destinationChainId: 1337, inTxHashes: [txHash], txHashes: [otherHash] };
    vi.stubGlobal('fetch', vi.fn(async () => response(status)));
    expect((await trackOrder(order)).status).toBe('attention'); status.originChainId = 8453;
    vi.spyOn(Date, 'now').mockReturnValue(now + 50000);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('status/v3') ? status : [])));
    expect((await trackOrder(order)).status).toBe('verifying_credit');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => response(url.includes('status/v3') ? status : [{ time: now + 1000, hash: otherHash, delta: { type: 'send', destination: q.recipient, destinationDex: '', token: 'USDC', amount: '9.98' } }])));
    expect(await trackOrder(order)).toMatchObject({ status: 'completed', evidence: expect.arrayContaining([{ type: 'base_finalized_transfer', reference: txHash }]) });
  });
});

type RpcRequest = { method: string; params: any[] };
function healthFetch(override?: (source: ReviewedEvmSource, body: RpcRequest, result: unknown) => unknown) {
  const requests: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/chains')) return response({ chains: canonical });
    const body = JSON.parse(String(init?.body)); requests.push({ url, body });
    if (url.endsWith('/quote/v2')) {
      const source = REVIEWED_EVM_SOURCES.find(s => s.route.sourceChainId === body.originChainId && s.route.sourceToken.toLowerCase() === body.originCurrency.toLowerCase())!;
      return response(raw(source.route.id));
    }
    const source = REVIEWED_EVM_SOURCES.find(s => new URL(s.publicRpcUrl).href === url)!;
    if (!source) throw new Error('unreviewed RPC');
    const token = body.method === 'eth_call' ? REVIEWED_EVM_SOURCES.find(s => s.route.sourceChainId === source.route.sourceChainId && s.route.sourceToken.toLowerCase() === body.params[0].to.toLowerCase()) : undefined;
    const normal = body.method === 'eth_chainId' ? `0x${source.route.sourceChainId.toString(16)}` : body.method === 'eth_getCode' ? '0x60006000' : body.method === 'eth_call' ? '0x' + token!.route.decimals.toString(16).padStart(64, '0') : { number: '0x100', hash: blockHash, transactions: [] };
    return response({ jsonrpc: '2.0', id: 1, result: override ? override(source, body, normal) : normal });
  }));
  return requests;
}

describe('live-RPC gate without production bypasses', () => {
  it('returns nine reviewed routes and coalesces network/token health reads for 60 seconds', async () => {
    vi.resetModules(); const calls = healthFetch(); const adapter = await import('../server/providers/relay.js');
    const routes = await adapter.getRoutes(); expect(routes).toHaveLength(9); expect(routes.every(r => r.available)).toBe(true);
    expect(calls.filter(c => c.body.method === 'eth_chainId')).toHaveLength(6);
    expect(calls.filter(c => c.body.method === 'eth_call')).toHaveLength(8);
    const count = calls.length; await adapter.getRoutes(); expect(calls).toHaveLength(count);
    const q = await adapter.getQuote(input('bsc-usdt-hypercore')); expect(q.amountBaseUnits).toBe('10000000000000000000');
    expect(calls.filter(c => c.body.method === 'eth_chainId')).toHaveLength(6);
  });
  it.each(['wrongChain', 'finalizedMissing', 'depositoryEmpty', 'rpcUnsupported'])('closes only a faulty BNB network for %s', async failure => {
    vi.resetModules(); healthFetch((source, body, result) => {
      if (source.route.sourceChainId !== 56) return result;
      if (failure === 'wrongChain' && body.method === 'eth_chainId') return '0x1';
      if (failure === 'finalizedMissing' && body.method === 'eth_getBlockByNumber') return null;
      if (failure === 'depositoryEmpty' && body.method === 'eth_getCode') return '0x';
      if (failure === 'rpcUnsupported' && body.method === 'eth_getBlockByNumber') throw new Error('unsupported finalized');
      return result;
    });
    const adapter = await import('../server/providers/relay.js'); const routes = await adapter.getRoutes();
    expect(routes.filter(r => !r.available).map(r => r.id)).toEqual(['bsc-usdt-hypercore']);
    await expect(adapter.getQuote(input('bsc-usdt-hypercore'))).rejects.toThrow();
    expect(vi.mocked(fetch).mock.calls.some(c => String(c[0]).endsWith('/quote/v2'))).toBe(false);
  });
  it('isolates token code/decimals failure from the other asset on the same network', async () => {
    for (const failure of ['code', 'decimals']) {
      vi.resetModules(); healthFetch((source, body, result) => {
        const token = failure === 'code' ? body.params[0] : body.params[0]?.to;
        if (source.route.sourceChainId === 1 && typeof token === 'string' && token.toLowerCase() === REVIEWED_EVM_SOURCES[1]!.route.sourceToken) {
          if (failure === 'code' && body.method === 'eth_getCode') return '0x';
          if (failure === 'decimals' && body.method === 'eth_call') return '0x' + '12'.padStart(64, '0');
        }
        return result;
      });
      const adapter = await import('../server/providers/relay.js');
      expect((await adapter.getRoutes()).filter(r => !r.available).map(r => r.id)).toEqual(['ethereum-usdc-hypercore']);
    }
  });
  it('retries failed health after its short cache, and never silently falls back to latest', async () => {
    vi.resetModules(); let current = now; vi.spyOn(Date, 'now').mockImplementation(() => current);
    let failing = true; const calls = healthFetch((source, body, result) => source.route.sourceChainId === 8453 && body.method === 'eth_getBlockByNumber' && failing ? null : result);
    const adapter = await import('../server/providers/relay.js');
    expect((await adapter.getRoutes()).find(r => r.id === 'base-usdc-hypercore')!.available).toBe(false);
    const count = calls.length; failing = false; await adapter.getRoutes(); expect(calls).toHaveLength(count);
    current += 15001; expect((await adapter.getRoutes()).find(r => r.id === 'base-usdc-hypercore')!.available).toBe(true);
    expect(calls.filter(c => c.body.method === 'eth_getBlockByNumber').every(c => c.body.params[0] === 'finalized')).toBe(true);
  });
  it('sends all 18 decimals exactly, and rejects overprecision before requesting any quote', async () => {
    vi.resetModules(); const calls = healthFetch(); const adapter = await import('../server/providers/relay.js');
    await expect(adapter.getQuote(input('bsc-usdt-hypercore', '10.000000000000000001'))).rejects.toThrow('金额'); // captured fixture is 10, not this amount
    expect(calls.find(c => c.url.endsWith('/quote/v2'))!.body.amount).toBe('10000000000000000001');
    const count = calls.length;
    await expect(adapter.getQuote(input('bsc-usdt-hypercore', '10.0000000000000000001'))).rejects.toThrow('18');
    expect(calls).toHaveLength(count);
  });
  it('uses only matching server RPC environment keys with HTTPS validation', () => {
    vi.stubEnv('BNB_RPC_URL', 'https://operator.example/bnb'); expect(evmRpcUrl('bsc-usdt-hypercore')).toBe('https://operator.example/bnb');
    expect(evmRpcUrl('ethereum-usdt-hypercore')).not.toContain('operator.example');
    vi.stubEnv('BNB_RPC_URL', 'http://operator.example/bnb'); expect(() => evmRpcUrl('bsc-usdt-hypercore')).toThrow('HTTPS');
    expect(() => evmRpcUrl('unknown')).toThrow('未审核');
  });
});
