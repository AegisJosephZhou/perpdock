import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrderId as officialOrderId } from '@relay-protocol/settlement-sdk';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { getOrderId } from '../server/providers/order-hash.js';
import { getQuote, getRoutes, trackOrder, validateRelayQuote } from '../server/providers/relay.js';
import * as solana from '../server/chain/solana.js';
import * as evmRpc from '../server/chain/evm-rpc.js';
import { buildSolanaDepositInstruction, deriveSolanaDepositAccounts, SOLANA_CHAIN_ID, SOLANA_DEPOSITORY, SOLANA_ROUTE_ID, SOLANA_USDC, SOLANA_VAULT, solanaAddress, solanaPayerAddress, solanaSignature, validateSolanaDepositData, validateSolanaInstructions } from '../shared/solana.js';
import type { StoredQuote, TrackedOrder } from '../shared/types.js';

const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/solana/${name}.json`, import.meta.url), 'utf8'));
const canonical = fixture('chains').chains;
const input = { routeId: SOLANA_ROUTE_ID, amount: '10', sourceAddress: fixture('quote').details.sender, recipient: fixture('quote').details.recipient };
const now = fixture('quote').protocol.v2.orderData.output.deadline * 1000 - 60_000;
const quote = async (): Promise<StoredQuote> => ({ ...await validateRelayQuote(fixture('quote'), input, canonical, now), id: 'solana-quote' });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Solana mainnet quote and protocol encoding', () => {
  it('validates the captured unsigned live quote against the SDK and rebuilds only a small exact deposit', async () => {
    const raw = fixture('quote');
    const q = await quote();
    const vms = { solana: 'solana-vm', base: 'ethereum-vm', hyperliquid: 'hyperliquid-vm' } as const;
    expect(q.protocolOrderId).toBe(getOrderId(raw.protocol.v2.orderData, vms));
    expect(q.protocolOrderId).toBe(officialOrderId(raw.protocol.v2.orderData, vms));
    expect(q.transaction).toEqual({ kind: 'solana', chainId: SOLANA_CHAIN_ID, instructions: [buildSolanaDepositInstruction(input.sourceAddress, '10000000', q.protocolOrderId!)] });
    expect(q.approval).toBeUndefined();
    expect(q.transaction).not.toHaveProperty('addressLookupTableAddresses');
    expect(q.warnings.join(' ')).toContain('SOL');
    const instruction = buildSolanaDepositInstruction(input.sourceAddress, q.amountBaseUnits, q.protocolOrderId!);
    const tx = new Transaction({ feePayer: new PublicKey(input.sourceAddress), recentBlockhash: PublicKey.default.toBase58() }).add(new TransactionInstruction({ programId: new PublicKey(instruction.programId), data: Buffer.from(instruction.data, 'hex'), keys: instruction.keys.map(k => ({ ...k, pubkey: new PublicKey(k.pubkey) })) }));
    expect(tx.serialize({ requireAllSignatures: false }).length).toBeLessThan(1232);
    const accounts = deriveSolanaDepositAccounts(input.sourceAddress);
    expect(accounts.relayDepository).toBe('Dodg2HifwU8rmaVVyMyUZDGTRbqAJTyVYxXPwcbNpBKc');
    expect(accounts.vault).toBe(SOLANA_VAULT);
    expect(accounts.vaultTokenAccount).toBe('4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia');
  });

  it.each([
    ['program substitution', (q: any) => { q.steps[0].items[0].data.instructions[0].programId = SOLANA_USDC; }],
    ['wrong amount', (q: any) => { const i = q.steps[0].items[0].data.instructions[0]; i.data = i.data.slice(0, 16) + '81' + i.data.slice(18); }],
    ['wrong order', (q: any) => { const i = q.steps[0].items[0].data.instructions[0]; i.data = i.data.slice(0, -2) + '00'; }],
    ['trailing instruction data', (q: any) => { q.steps[0].items[0].data.instructions[0].data += '00'; }],
    ['second transfer', (q: any) => { q.steps[0].items[0].data.instructions.push(q.steps[0].items[0].data.instructions[0]); }],
    ['unknown transaction field', (q: any) => { q.steps[0].items[0].data.transaction = 'opaque'; }],
    ['unsupported v1 transaction', (q: any) => { q.steps[0].items[0].data.transactionVersion = 1; }],
    ['provider-selected fee payer', (q: any) => { q.steps[0].items[0].data.feePayer = SOLANA_USDC; }],
    ['extra account', (q: any) => { const i = q.steps[0].items[0].data.instructions[0]; i.keys.push(i.keys[0]); }],
    ['unbounded priority fee', (q: any) => { q.steps[0].items[0].data.instructions.unshift({ programId: 'ComputeBudget111111111111111111111111111111', keys: [], data: '03ffffffffffffffff' }); }],
    ['refund payer case', (q: any) => { q.protocol.v2.orderData.inputs[0].refunds[0].recipient = input.sourceAddress.toLowerCase(); }],
    ['wrong destination account', (q: any) => { q.details.recipient = '0x2222222222222222222222222222222222222222'; }],
    ['Spot output', (q: any) => { q.protocol.v2.orderData.output.payments[0].currency = '0x6d1e7cde53ba9467b783cb7c530ce054'; }],
    ['approval action', (q: any) => { q.steps.push({ ...q.steps[0], id: 'approve' }); }],
  ] as const)('rejects %s before returning wallet instructions', async (_name, mutate) => {
    const q = fixture('quote'); mutate(q);
    await expect(validateRelayQuote(q, input, canonical, now)).rejects.toThrow();
  });
  it.each(Array.from({ length: 10 }, (_, i) => i))('rejects substitution or privilege escalation of deposit account %s', async index => {
    for (const field of ['pubkey', 'isSigner', 'isWritable'] as const) {
      const q = fixture('quote');
      const key = q.steps[0].items[0].data.instructions[0].keys[index];
      key[field] = field === 'pubkey' ? (key.pubkey === SOLANA_USDC ? SOLANA_DEPOSITORY : SOLANA_USDC) : !key[field];
      await expect(validateRelayQuote(q, input, canonical, now)).rejects.toThrow();
    }
  });
  it.each(['chainId', 'depository', 'depositoryVault', 'vmType', 'disabled', 'depositEnabled'])('fails closed on canonical registry mismatch: %s', async field => {
    const chains = fixture('chains').chains;
    const entry = chains.find((c: any) => c.id === SOLANA_CHAIN_ID);
    if (field === 'chainId') entry.protocol.v2.chainId = 'solana-devnet';
    else if (field === 'depository' || field === 'depositoryVault') entry.protocol.v2[field] = SOLANA_USDC;
    else if (field === 'vmType') entry.vmType = 'evm';
    else entry[field] = field === 'disabled';
    await expect(validateRelayQuote(fixture('quote'), input, chains, now)).rejects.toThrow();
  });
  it('rejects unsupported assets, precision and expiry without guessing a route', async () => {
    for (const routeId of ['solana-usdt-hypercore', 'solana-sol-hypercore']) await expect(validateRelayQuote(fixture('quote'), { ...input, routeId }, canonical, now)).rejects.toThrow();
    await expect(validateRelayQuote(fixture('quote'), { ...input, amount: '10.0000001' }, canonical, now)).rejects.toThrow();
    await expect(validateRelayQuote(fixture('quote'), input, canonical, now + 60_000)).rejects.toThrow();
  });
});

describe('shared Solana wallet guard', () => {
  it('rejects invalid lengths, invalid alphabet and PDA payers while preserving signature case', () => {
    expect(solanaAddress(SOLANA_USDC)).toBe(SOLANA_USDC);
    expect(() => solanaAddress('1'.repeat(31))).toThrow();
    expect(() => solanaAddress('0'.repeat(32))).toThrow();
    expect(() => solanaPayerAddress(SOLANA_VAULT)).toThrow();
    const hash = bs58.encode(new Uint8Array(64).fill(7));
    expect(solanaSignature(hash)).toBe(hash);
    expect(() => solanaSignature(SOLANA_USDC)).toThrow();
    expect(() => buildSolanaDepositInstruction(input.sourceAddress, '18446744073709551616', '0x' + '12'.repeat(32))).toThrow();
  });
  it('uses the same full guard in the client and server, with no hidden provider actions', () => {
    const raw = fixture('quote');
    const data = raw.steps[0].items[0].data;
    const args = [input.sourceAddress, '10000000', raw.protocol.v2.orderId] as const;
    expect(validateSolanaInstructions(data.instructions, ...args)).toEqual(validateSolanaDepositData(data, ...args));
    expect(() => validateSolanaInstructions(data.instructions, args[0], '10000001', args[2])).toThrow();
    const malformed = structuredClone(data.instructions); malformed[0].keys[0].extra = 'action';
    expect(() => validateSolanaInstructions(malformed, ...args)).toThrow();
  });
});

describe('Solana Relay tracking', () => {
  it('does not lowercase Solana source transaction signatures', async () => {
    const { providerData, ...publicQuote } = await quote();
    const hash = bs58.encode(new Uint8Array(64).fill(7));
    const order: TrackedOrder = { id: 'solana-order', quote: publicQuote, providerData, sourceTxHash: hash, status: 'source_pending', statusMessage: '', events: [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    vi.spyOn(solana, 'verifySolanaSource').mockResolvedValue({ valid: true, pending: false });
    const status = { status: 'success', originChainId: SOLANA_CHAIN_ID, destinationChainId: 1337, inTxHashes: [hash.toLowerCase()], txHashes: ['0x' + '55'.repeat(32)] };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status))));
    expect((await trackOrder(order)).status).toBe('attention');
    status.inTxHashes = [hash];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('status/v3') ? status : []))));
    vi.spyOn(Date, 'now').mockReturnValue(now + 1_000);
    expect((await trackOrder(order)).status).toBe('verifying_credit');
  });
});

describe('Solana quote admission', () => {
  it('requests only the reviewed exact-input route after a successful mainnet health check', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const health = vi.spyOn(solana, 'assertSolanaSourceHealthy').mockResolvedValue();
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/chains')) return new Response(JSON.stringify({ chains: canonical }));
      expect(url).toBe('https://api.relay.link/quote/v2');
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(fixture('quote')));
    }));
    expect((await getQuote(input)).transaction.kind).toBe('solana');
    expect(health).toHaveBeenCalledOnce();
    expect(bodies).toEqual([{ user: input.sourceAddress, recipient: input.recipient, originChainId: SOLANA_CHAIN_ID, destinationChainId: 1337, originCurrency: SOLANA_USDC, destinationCurrency: '0x00000000000000000000000000000000', amount: '10000000', tradeType: 'EXACT_INPUT', protocolVersion: 'v2', includeProtocolData: true, explicitDeposit: true, useDepositAddress: false, refundTo: input.sourceAddress, slippageTolerance: '100' }]);
  });
  it('closes the Solana route and refuses new quotes when mainnet health cannot be verified', async () => {
    vi.spyOn(solana, 'assertSolanaSourceHealthy').mockRejectedValue(new Error('RPC unavailable'));
    vi.spyOn(evmRpc, 'assertEvmSourceHealthy').mockResolvedValue();
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.relay.link/chains');
      return new Response(JSON.stringify({ chains: canonical }));
    });
    vi.stubGlobal('fetch', fetch);
    await expect(getQuote(input)).rejects.toThrow('RPC unavailable');
    expect((await getRoutes()).find(r => r.id === SOLANA_ROUTE_ID)).toMatchObject({ available: false });
    expect(fetch.mock.calls.every(([url]) => url.endsWith('/chains'))).toBe(true);
  });
});
