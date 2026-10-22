import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import type { StoredQuote } from '../shared/types.js';
import { buildSolanaDepositInstruction, deriveSolanaDepositAccounts, SOLANA_CHAIN_ID, SOLANA_DEPOSITORY, SOLANA_GENESIS_HASH, SOLANA_ROUTE_ID, SOLANA_TOKEN_PROGRAM, SOLANA_USDC } from '../shared/solana.js';

const source = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const signature = bs58.encode(Buffer.alloc(64, 71));
const orderId = `0x${'ab'.repeat(32)}`;
const accounts = deriveSolanaDepositAccounts(source);
const slot = 123_456;
const fee = 5_000;
const amount = 10_000_000n;
const accountRent = 2_039_280;

function quote(): StoredQuote {
  return {
    id: 'solana-source-quote', routeId: SOLANA_ROUTE_ID, sourceAddress: source, recipient: `0x${'11'.repeat(20)}`,
    amount: '10', amountBaseUnits: amount.toString(), expectedReceive: '9.9', minReceive: '9.8', expiresAt: '2030-01-01T00:00:00.000Z',
    provider: 'relay', fees: [], protocolOrderId: orderId, warnings: [],
    transaction: { kind: 'solana', chainId: SOLANA_CHAIN_ID, instructions: [buildSolanaDepositInstruction(source, amount.toString(), orderId)] },
    providerData: { requestId: 'relay-request', orderId },
  };
}

function sourceTransaction() {
  const deposit = buildSolanaDepositInstruction(source, amount.toString(), orderId);
  const compiled = new TransactionMessage({ payerKey: new PublicKey(source), recentBlockhash: SOLANA_GENESIS_HASH, instructions: [new TransactionInstruction({ programId: new PublicKey(deposit.programId), keys: deposit.keys.map(key => ({ ...key, pubkey: new PublicKey(key.pubkey) })), data: Buffer.from(deposit.data, 'hex') })] }).compileToV0Message();
  const keys = compiled.staticAccountKeys.map(key => key.toBase58());
  const senderIndex = keys.indexOf(accounts.senderTokenAccount);
  const vaultIndex = keys.indexOf(accounts.vaultTokenAccount);
  const token = (index: number, owner: string, balance: bigint) => ({ accountIndex: index, mint: SOLANA_USDC, owner, programId: SOLANA_TOKEN_PROGRAM, uiTokenAmount: { amount: balance.toString(), decimals: 6 } });
  const data = Buffer.alloc(9); data[0] = 3; data.writeBigUInt64LE(amount, 1);
  const preBalances = keys.map(() => accountRent); preBalances[0] = 100_000_000;
  const postBalances = [...preBalances]; postBalances[0]! -= fee;
  return {
    slot, version: 0 as const,
    transaction: { signatures: [signature], message: {
      accountKeys: keys, recentBlockhash: SOLANA_GENESIS_HASH, header: { ...compiled.header }, addressTableLookups: [],
      instructions: compiled.compiledInstructions.map(instruction => ({ programIdIndex: instruction.programIdIndex, accounts: [...instruction.accountKeyIndexes], data: bs58.encode(instruction.data) })),
    } },
    meta: {
      err: null as unknown, fee, preBalances, postBalances, loadedAddresses: { writable: [] as string[], readonly: [] as string[] },
      preTokenBalances: [token(senderIndex, source, 30_000_000n), token(vaultIndex, accounts.vault, 50_000_000n)],
      postTokenBalances: [token(senderIndex, source, 20_000_000n), token(vaultIndex, accounts.vault, 60_000_000n)],
      innerInstructions: [{ index: 0, instructions: [{ programIdIndex: keys.indexOf(SOLANA_TOKEN_PROGRAM), accounts: [senderIndex, vaultIndex, 0], data: bs58.encode(data) }] }],
    },
  };
}

function statusResult() { return { context: { slot: slot + 10 }, value: [{ slot, confirmations: null as number | null, err: null as unknown, confirmationStatus: 'finalized' }] }; }
function healthProgram() { return { context: { slot }, value: { executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111' } }; }
function healthMint() { return { context: { slot }, value: { executable: false, owner: SOLANA_TOKEN_PROGRAM, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, isInitialized: true } } } } }; }

let transaction: ReturnType<typeof sourceTransaction> | null;
let statuses: ReturnType<typeof statusResult>;
let genesis: unknown;
let program: ReturnType<typeof healthProgram>;
let mint: ReturnType<typeof healthMint>;
let fetchMock: ReturnType<typeof vi.fn>;
const rpcCalls = () => fetchMock.mock.calls.map(([, init]) => { const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] }; return { method, params }; });
const verifier = async () => (await import('../server/chain/solana.js')).verifySolanaSource;

beforeEach(() => {
  vi.resetModules(); vi.unstubAllEnvs();
  transaction = sourceTransaction(); statuses = statusResult(); genesis = SOLANA_GENESIS_HASH; program = healthProgram(); mint = healthMint();
  fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    let result: unknown;
    if (body.method === 'getGenesisHash') result = genesis;
    else if (body.method === 'getTransaction') result = transaction;
    else if (body.method === 'getSignatureStatuses') result = statuses;
    else if (body.method === 'getSlot') result = slot;
    else if (body.method === 'getAccountInfo') result = body.params[0] === SOLANA_DEPOSITORY ? program : mint;
    else throw new Error(`Unexpected method: ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('Solana finalized source verification', () => {
  it('binds the unique payer, exact deposit and token deltas, with historical finalized confirmation', async () => {
    expect(await (await verifier())(quote(), signature)).toEqual({ valid: true, pending: false, providerOrderId: 'relay-request' });
    expect(rpcCalls()).toContainEqual({ method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }] });
    expect(rpcCalls()).toContainEqual({ method: 'getSignatureStatuses', params: [[signature], { searchTransactionHistory: true }] });
    expect(fetchMock.mock.calls.every(([url]) => url === 'https://api.mainnet-beta.solana.com/')).toBe(true);
  });

  it('accepts the SPL checked transfer form with 6 decimal USDC', async () => {
    const tx = transaction!;
    const data = Buffer.alloc(10); data[0] = 12; data.writeBigUInt64LE(amount, 1); data[9] = 6;
    const inner = tx.meta.innerInstructions[0]!.instructions[0]!;
    inner.data = bs58.encode(data); inner.accounts.splice(1, 0, tx.transaction.message.accountKeys.indexOf(SOLANA_USDC));
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: false });
  });

  it('accepts legacy messages compiled with the same strict account privileges', async () => {
    (transaction as unknown as { version: string }).version = 'legacy';
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: false });
  });

  it.each(['invalid0signature', bs58.encode(Buffer.alloc(63, 71)), bs58.encode(Buffer.alloc(65, 71)), ` ${signature}`, `${signature} `])('rejects malformed signature %s without RPC work', async invalid => {
    expect((await (await verifier())(quote(), invalid)).valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves signature case and rejects a different valid base58 signature', async () => {
    const other = bs58.encode(Buffer.alloc(64, 72));
    expect((await (await verifier())(quote(), other)).valid).toBe(false);
    expect(rpcCalls().find(call => call.method === 'getTransaction')!.params[0]).toBe(other);
  });

  it.each([
    ['wrong route', (q: StoredQuote) => { q.routeId = 'ethereum-usdc'; }],
    ['wrong chain', (q: StoredQuote) => { if (q.transaction.kind === 'solana') q.transaction.chainId = 1; }],
    ['wrong protocol ID', (q: StoredQuote) => { q.protocolOrderId = `0x${'cd'.repeat(32)}`; }],
    ['wrong display amount', (q: StoredQuote) => { q.amount = '11'; }],
    ['wrong base units', (q: StoredQuote) => { q.amountBaseUnits = '9000000'; }],
    ['extra precision', (q: StoredQuote) => { q.amount = '10.0000001'; }],
    ['missing request ID', (q: StoredQuote) => { delete q.providerData.requestId; }],
  ])('rejects the stored quote with %s before RPC work', async (_name, mutate) => {
    const q = quote(); mutate(q);
    expect((await (await verifier())(q, signature)).valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-mainnet genesis even when transaction and status appear valid', async () => {
    genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it('keeps a missing finalized transaction pending, never accepted as proof', async () => {
    transaction = null;
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: true });
  });

  it('keeps a missing historical signature status pending', async () => {
    (statuses.value as unknown[]) = [null];
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: true });
  });

  it.each(['processed', 'confirmed'])('keeps %s confirmation pending', async confirmation => {
    statuses.value[0]!.confirmationStatus = confirmation; statuses.value[0]!.confirmations = 20;
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: true });
  });

  it('keeps a missing meta execution record pending', async () => {
    (transaction as unknown as { meta: null }).meta = null;
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: true });
  });

  it.each(['transaction', 'status', 'failed status before transaction lookup'])('rejects execution failure reported in %s', async location => {
    if (location === 'transaction') transaction!.meta.err = { InstructionError: [0, { Custom: 6001 }] };
    else { statuses.value[0]!.err = 'AccountNotFound'; if (location.startsWith('failed')) transaction = null; }
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it.each(['slot mismatch', 'context behind'])('rejects %s', async mismatch => {
    if (mismatch === 'slot mismatch') statuses.value[0]!.slot--;
    else statuses.context.slot = slot - 1;
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it.each([
    ['different payer', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.accountKeys[0] = SOLANA_USDC; }],
    ['different transaction signature', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.signatures[0] = bs58.encode(Buffer.alloc(64, 72)); }],
    ['program', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.instructions[0]!.programIdIndex = 0; }],
    ['account sequence', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.instructions[0]!.accounts.reverse(); }],
    ['PDA', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.accountKeys[tx.transaction.message.accountKeys.indexOf(accounts.relayDepository)] = SOLANA_GENESIS_HASH; }],
    ['mint', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.accountKeys[tx.transaction.message.accountKeys.indexOf(SOLANA_USDC)] = SOLANA_GENESIS_HASH; }],
    ['vault ATA', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.accountKeys[tx.transaction.message.accountKeys.indexOf(accounts.vaultTokenAccount)] = SOLANA_GENESIS_HASH; }],
    ['amount bytes', (tx: ReturnType<typeof sourceTransaction>) => { const ix = tx.transaction.message.instructions[0]!; const bytes = bs58.decode(ix.data); bytes[8]! ^= 1; ix.data = bs58.encode(bytes); }],
    ['order hash bytes', (tx: ReturnType<typeof sourceTransaction>) => { const ix = tx.transaction.message.instructions[0]!; const bytes = bs58.decode(ix.data); bytes[16]! ^= 1; ix.data = bs58.encode(bytes); }],
    ['excess writable privilege', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.header.numReadonlyUnsignedAccounts--; }],
    ['missing writable privilege', (tx: ReturnType<typeof sourceTransaction>) => { tx.transaction.message.header.numReadonlyUnsignedAccounts++; }],
  ])('rejects altered %s', async (_name, mutate) => {
    mutate(transaction!);
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it.each([
    ['source debit', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[0]!.uiTokenAmount.amount = '19999999'; }],
    ['vault credit', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = '59999999'; }],
    ['source owner', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[0]!.owner = accounts.vault; }],
    ['vault owner', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[1]!.owner = source; }],
    ['mint', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[1]!.mint = SOLANA_GENESIS_HASH; }],
    ['decimals', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.preTokenBalances[0]!.uiTokenAmount.decimals = 9; }],
    ['token program', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postTokenBalances[0]!.programId = SOLANA_DEPOSITORY; }],
    ['duplicate token record', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.preTokenBalances.push({ ...tx.meta.preTokenBalances[0]! }); }],
    ['missing source record', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.preTokenBalances.shift(); }],
    ['extra SOL debit', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postBalances[0]!--; }],
    ['unexpected lamport movement', (tx: ReturnType<typeof sourceTransaction>) => { tx.meta.postBalances[tx.transaction.message.accountKeys.indexOf(accounts.senderTokenAccount)]!++; }],
    ['another token debit', (tx: ReturnType<typeof sourceTransaction>) => {
      const base = { ...tx.meta.preTokenBalances[0]!, accountIndex: tx.transaction.message.accountKeys.indexOf(SOLANA_USDC), mint: SOLANA_GENESIS_HASH };
      tx.meta.preTokenBalances.push({ ...base, uiTokenAmount: { amount: '100', decimals: 9 } });
      tx.meta.postTokenBalances.push({ ...base, uiTokenAmount: { amount: '90', decimals: 9 } });
    }],
  ])('rejects mismatched balances: %s', async (_name, mutate) => {
    mutate(transaction!);
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it.each(['missing', 'duplicate', 'different authority', 'different amount', 'unexpected approval', 'unexpected program'])('rejects %s inner transfer', async change => {
    const list = transaction!.meta.innerInstructions[0]!.instructions;
    if (change === 'missing') list.length = 0;
    else if (change === 'duplicate') list.push({ ...list[0]! });
    else if (change === 'different authority') list[0]!.accounts[2] = list[0]!.accounts[1]!;
    else if (change === 'unexpected program') list[0]!.programIdIndex = 0;
    else { const bytes = bs58.decode(list[0]!.data); bytes[change === 'different amount' ? 1 : 0] = change === 'different amount' ? 1 : 4; list[0]!.data = bs58.encode(bytes); }
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it('allows only the necessary, fully bound creation of the vault ATA and its rent', async () => {
    const tx = transaction!, keys = tx.transaction.message.accountKeys;
    const vaultIndex = keys.indexOf(accounts.vaultTokenAccount);
    tx.meta.preTokenBalances.pop(); tx.meta.postTokenBalances[1]!.uiTokenAmount.amount = amount.toString();
    tx.meta.preBalances[vaultIndex] = 0; tx.meta.postBalances[0]! -= accountRent;
    const instruction = (programId: string, addresses: string[], data: Buffer) => ({ programIdIndex: keys.indexOf(programId), accounts: addresses.map(key => keys.indexOf(key)), data: bs58.encode(data) });
    const create = Buffer.alloc(52); create.writeBigUInt64LE(BigInt(accountRent), 4); create.writeBigUInt64LE(165n, 12); Buffer.from(bs58.decode(SOLANA_TOKEN_PROGRAM)).copy(create, 20);
    const init = Buffer.concat([Buffer.from([18]), Buffer.from(bs58.decode(accounts.vault))]);
    tx.meta.innerInstructions[0]!.instructions.unshift(
      instruction(accounts.associatedTokenProgram, [source, accounts.vaultTokenAccount, accounts.vault, SOLANA_USDC, accounts.systemProgram, SOLANA_TOKEN_PROGRAM], Buffer.from([1])),
      instruction(SOLANA_TOKEN_PROGRAM, [SOLANA_USDC], Buffer.from([21])),
      instruction(accounts.systemProgram, [source, accounts.vaultTokenAccount], create),
      instruction(SOLANA_TOKEN_PROGRAM, [accounts.vaultTokenAccount], Buffer.from([22])),
      instruction(SOLANA_TOKEN_PROGRAM, [accounts.vaultTokenAccount, SOLANA_USDC], init),
    );
    expect(await (await verifier())(quote(), signature)).toMatchObject({ valid: true, pending: false });
    tx.meta.postBalances[0]!--;
    expect((await (await verifier())(quote(), signature)).valid).toBe(false);
  });

  it.each(['extra signer', 'lookup table', 'loaded addresses', 'extra instruction', 'missing status error', 'malformed token amount'])('fails closed on unsupported or incomplete RPC data: %s', async change => {
    if (change === 'extra signer') transaction!.transaction.message.header.numRequiredSignatures = 2;
    else if (change === 'lookup table') (transaction!.transaction.message.addressTableLookups as unknown[]).push({});
    else if (change === 'loaded addresses') transaction!.meta.loadedAddresses.writable.push(source);
    else if (change === 'extra instruction') transaction!.transaction.message.instructions.push({ ...transaction!.transaction.message.instructions[0]! });
    else if (change === 'missing status error') delete (statuses.value[0] as { err?: unknown }).err;
    else transaction!.meta.postTokenBalances[0]!.uiTokenAmount.amount = '1e7';
    await expect((await verifier())(quote(), signature)).rejects.toMatchObject({ code: 'SOLANA_RPC_ERROR' });
  });

  it('throws a sanitized unavailable result on transport or RPC failures, never pending', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example/?api-key=DO_NOT_LEAK');
    fetchMock.mockRejectedValue(new Error('https://rpc.example/?api-key=DO_NOT_LEAK'));
    await expect((await verifier())(quote(), signature)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'DO_NOT_LEAK' } })));
    await expect((await verifier())(quote(), signature)).rejects.toThrow(/^Solana RPC 尚未提供可靠结果/);
  });
});

describe('Solana source health', () => {
  it('requires pinned mainnet, a finalized slot, the reviewed program and initialized 6 decimal USDC', async () => {
    const { assertSolanaSourceHealthy } = await import('../server/chain/solana.js');
    await assertSolanaSourceHealthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await assertSolanaSourceHealthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(rpcCalls()).toContainEqual({ method: 'getAccountInfo', params: [SOLANA_USDC, { commitment: 'finalized', encoding: 'jsonParsed' }] });
  });

  it.each(['network', 'program', 'loader', 'mint owner', 'mint decimals', 'mint initialization'])('closes new quotes on a wrong %s', async change => {
    if (change === 'network') genesis = 'wrong';
    else if (change === 'program') program.value.executable = false;
    else if (change === 'loader') program.value.owner = SOLANA_TOKEN_PROGRAM;
    else if (change === 'mint owner') mint.value.owner = SOLANA_DEPOSITORY;
    else if (change === 'mint decimals') mint.value.data.parsed.info.decimals = 9;
    else mint.value.data.parsed.info.isInitialized = false;
    const { assertSolanaSourceHealthy } = await import('../server/chain/solana.js');
    await expect(assertSolanaSourceHealthy()).rejects.toBeInstanceOf(Error);
    await expect(assertSolanaSourceHealthy()).rejects.toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not silently accept rate limits as proof of route health', async () => {
    fetchMock.mockImplementation(async () => new Response('rate limit', { status: 429 }));
    const { assertSolanaSourceHealthy } = await import('../server/chain/solana.js');
    await expect(assertSolanaSourceHealthy()).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
  });

  it.each(['http://rpc.example', 'https://user:secret@rpc.example/', 'https://rpc.example/#secret', 'invalid'])('rejects unsafe operator configuration without exposing it', async url => {
    vi.stubEnv('SOLANA_RPC_URL', url);
    const { solanaRpcUrl } = await import('../server/chain/solana.js');
    expect(solanaRpcUrl).toThrow(/^Solana RPC 必须使用无 URL 凭据或片段的 HTTPS 地址。$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the operator HTTPS endpoint without returning its query key in errors', async () => {
    vi.stubEnv('SOLANA_RPC_URL', 'https://rpc.example/solana?key=DO_NOT_LEAK');
    const { solanaRpcUrl, solanaRpc } = await import('../server/chain/solana.js');
    expect(solanaRpcUrl()).toBe('https://rpc.example/solana?key=DO_NOT_LEAK');
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'DO_NOT_LEAK' } })));
    try { await solanaRpc('getGenesisHash', []); expect.fail('must reject'); }
    catch (error) { expect(String(error)).not.toContain('DO_NOT_LEAK'); expect(String(error)).not.toContain('rpc.example'); }
  });
});
