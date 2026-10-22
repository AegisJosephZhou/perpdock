import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { getOrderId as officialOrderId } from '@relay-protocol/settlement-sdk';
import { validateRelayQuote, TRON_DEPOSITORY } from '../server/providers/relay.js';
import { getOrderId, type RelayOrder } from '../server/providers/order-hash.js';
import { findPerpsCredit, scanPerpsCredit, type Ledger } from '../server/chain/hyperliquid.js';
import { tronHex, verifyTronSource } from '../server/chain/tron.js';
import type { StoredQuote } from '../shared/types.js';

const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const raw = () => fixture('relay-tron-quote.json');
const canonical = fixture('relay-chains.json').chains;
const input = { routeId: 'tron-usdt-hypercore', amount: '100', sourceAddress: raw().details.sender, recipient: raw().details.recipient };
const now = 1791831787228;
const vms = { tron: 'tron-vm', hyperliquid: 'hyperliquid-vm', base: 'ethereum-vm' } as const;
const validated = async () => validateRelayQuote(raw(), input, canonical, now);

afterEach(() => vi.unstubAllGlobals());

describe('bounded HyperCore ledger recovery', () => {
  const recipient = '0x1111111111111111111111111111111111111111';
  const hash = '0x' + '77'.repeat(32);
  const credit = (time: number): Ledger[number] => ({ time, hash, delta: { type: 'send', destination: recipient, destinationDex: '', token: 'USDC', amount: '99' } });
  const noise = (time: number): Ledger[number] => ({ time, hash: 'unrelated', delta: {} });
  const stubLedger = (entries: Ledger) => vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(entries.filter(entry => entry.time >= body.startTime && entry.time <= body.endTime).slice(0, 500)));
  }));
  it('finds a credit beyond the API result cap while overlapping the boundary timestamp', async () => {
    stubLedger([...Array.from({ length: 500 }, (_, i) => noise(i + 1)), credit(501)]);
    expect(await scanPerpsCredit(recipient, [hash], '98', 0, 1000)).toMatchObject({ credit: { hash, amount: '99' } });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body)).startTime).toBe(500);
  });
  it('caps each poll at four pages and resumes from persisted cursor', async () => {
    stubLedger([...Array.from({ length: 2300 }, (_, i) => noise(i + 1)), credit(2301)]);
    const first = await scanPerpsCredit(recipient, [hash], '98', 0, 5000);
    expect(first.credit).toBeUndefined(); expect(fetch).toHaveBeenCalledTimes(4);
    expect(first.nextStartTime).toBe(1997);
    expect((await scanPerpsCredit(recipient, [hash], '98', 0, 5000, first.nextStartTime)).credit?.hash).toBe(hash);
  });
  it('rewinds a fully scanned range so late-indexed historical credit is recovered', async () => {
    stubLedger([noise(10)]);
    const first = await scanPerpsCredit(recipient, [hash], '98', 0, 1000);
    expect(first.nextStartTime).toBe(0);
    stubLedger([noise(10), credit(50)]);
    expect((await scanPerpsCredit(recipient, [hash], '98', 0, 1000, first.nextStartTime)).credit?.hash).toBe(hash);
  });
  it('does not skip an unpageable timestamp or manufacture completion', async () => {
    stubLedger(Array.from({ length: 500 }, () => noise(10)));
    expect(await scanPerpsCredit(recipient, [hash], '98', 0, 1000)).toEqual({ nextStartTime: 10 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
describe('Relay verified mainnet quote', () => {
  it('validates captured live order hash, solver signature and exact Tron calldata', async () => {
    const quote = await validated();
    expect(quote.minReceive).toBe('97.739931');
    expect(quote.approval).toEqual({ token: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', spender: TRON_DEPOSITORY, amount: '100000000' });
    expect(quote.expiresAt).toBe(new Date(now + 120000).toISOString());
  });
  it('matches official SDK on live quote and changed encoding vectors', () => {
    const original = raw().protocol.v2.orderData as RelayOrder;
    const variants = [original, structuredClone(original), structuredClone(original), structuredClone(original)];
    variants[1]!.output.payments[0]!.minimumAmount = '123456789';
    variants[2]!.inputs[0]!.refunds[0]!.recipient = TRON_DEPOSITORY;
    variants[3]!.salt = '0xffff';
    for (const o of variants) expect(getOrderId(o, vms)).toBe(officialOrderId(o as Parameters<typeof officialOrderId>[0], vms));
    expect(getOrderId(original, vms)).toBe(raw().protocol.v2.orderId);
  });
  it('rejects recipient substitution before signing', async () => {
    await expect(validateRelayQuote(raw(), {...input, recipient:'0x1111111111111111111111111111111111111111'}, canonical, now)).rejects.toThrow();
  });
  it('rejects minimum-output tampering even when display fields match', async () => {
    const q = raw(); q.protocol.v2.orderData.output.payments[0].minimumAmount='1'; q.details.currencyOut.minimumAmount='1';
    await expect(validateRelayQuote(q,input,canonical,now)).rejects.toThrow('哈希');
  });
  it('rejects tampered approval, contract, native value and extra calldata', async () => {
    const mutations = [
      (q: any) => { q.steps[0].items[0].data.parameter.data = q.steps[0].items[0].data.parameter.data.slice(0,-64)+'f'.repeat(64); },
      (q: any) => { q.steps[1].items[0].data.parameter.contract_address = '41'+'1'.repeat(40); },
      (q: any) => { q.steps[1].items[0].data.parameter.call_value = 1; },
      (q: any) => { q.steps[1].items[0].data.parameter.data += '00'; },
    ];
    for (const mutate of mutations) {const q=raw(); mutate(q); await expect(validateRelayQuote(q,input,canonical,now)).rejects.toThrow();}
  });
  it('rejects quote-provided depository when independent registry differs', async () => {
    const altered = structuredClone(canonical); altered.find((c: any) => c.id===728126428).protocol.v2.depository=input.sourceAddress;
    await expect(validateRelayQuote(raw(),input,altered,now)).rejects.toThrow('depository');
  });
  it('rejects protocol expiry, unknown calls and untrusted solver signature', async () => {
    const q=raw(); q.protocol.v2.orderSignature='0x'+'1'.repeat(130);
    await expect(validateRelayQuote(q,input,canonical,now)).rejects.toThrow();
    await expect(validateRelayQuote(raw(),input,canonical,raw().protocol.v2.orderData.output.deadline*1000)).rejects.toThrow('期限');
    const q2=raw();q2.protocol.v2.orderData.output.calls=['0x'];
    await expect(validateRelayQuote(q2,input,canonical,now)).rejects.toThrow();
  });
  it('rejects amount precision and Tron checksum errors', async () => {
    expect(() => tronHex(input.sourceAddress.slice(0,-1)+'8')).toThrow();
    await expect(validateRelayQuote(raw(),{...input,amount:'100.0000001'},canonical,now)).rejects.toThrow();
  });
});

describe('positive HyperCore credit evidence', () => {
  const ledger = fixture<Ledger>('hl-fill-ledger.json');
  const status = fixture('relay-history-status.json');
  const recipient = '0x1d26f48ac0c949d739461bffebb5bfd0148676cf';
  it('matches live historical Relay source+destination status to actual default-Perps ledger', () => {
    expect(findPerpsCredit(ledger,recipient,status.txHashes,'500',1791816116000)).toEqual({hash:status.txHashes[0],amount:'506.546688',time:1791816176907});
  });
  it('does not count spot credit, wrong recipient/hash, insufficient amount or earlier transaction', () => {
    expect(findPerpsCredit(ledger,recipient,[],'500',0)).toBeUndefined();
    expect(findPerpsCredit(ledger,input.recipient,status.txHashes,'500',0)).toBeUndefined();
    expect(findPerpsCredit(ledger,recipient,status.txHashes,'507',0)).toBeUndefined();
    expect(findPerpsCredit(ledger,recipient,status.txHashes,'500',1791816177000)).toBeUndefined();
    const spot = structuredClone(ledger);spot[0]!.delta.destinationDex='spot';
    expect(findPerpsCredit(spot,recipient,status.txHashes,'500',0)).toBeUndefined();
  });
});

describe('Tron finality and payment verification', () => {
  const hash = createHash('sha256').update(Buffer.from('1234','hex')).digest('hex');
  async function setup(receiptChange?: (r:any)=>void) {
    const quote = {...await validated(),id:'test-quote'} as StoredQuote;
    const intent:any = quote.transaction.kind==='tron' ? quote.transaction.transaction : undefined;
    const tx={txID:hash,raw_data_hex:'1234',raw_data:{contract:[{type:'TriggerSmartContract',parameter:{value:intent.parameter}}]},ret:[{contractRet:'SUCCESS'}]};
    const receipt={id:hash,receipt:{result:'SUCCESS'},log:[{address:tronHex(quote.approval!.token).slice(2),topics:['ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',tronHex(input.sourceAddress).slice(2).padStart(64,'0'),tronHex(TRON_DEPOSITORY).slice(2).padStart(64,'0')],data:BigInt(quote.amountBaseUnits).toString(16).padStart(64,'0')}]};
    receiptChange?.(receipt);
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.includes('gettransactioninfobyid')?receipt:tx),{status:200})));
    return quote;
  }
  it('accepts only finalized successful matching call AND token transfer',async()=>{
    const quote=await setup();expect(await verifyTronSource(quote,hash)).toMatchObject({valid:true,pending:false});
  });
  it('rejects finalized revert and missing USDT event',async()=>{
    let quote=await setup(r=>{r.receipt.result='REVERT';});expect((await verifyTronSource(quote,hash)).valid).toBe(false);
    quote=await setup(r=>{r.log=[];});expect((await verifyTronSource(quote,hash)).valid).toBe(false);
  });
  it('does not confuse unindexed finality with successful transfer',async()=>{
    const quote=await setup();vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}',{status:200})));
    expect(await verifyTronSource(quote,hash)).toMatchObject({valid:true,pending:true});
  });
});
