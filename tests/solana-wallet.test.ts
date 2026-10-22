/** Synthetic keys sign only isolated test transactions. All RPC is intercepted. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'buffer';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH, SOLANA_ROUTE, SOLANA_TOKEN_PROGRAM, SOLANA_USDC, buildSolanaDepositInstruction } from '../shared/solana.js';
import type { Quote } from '../shared/types.js';
import { connectSolana, disconnectSolana, listSolanaWallets, solanaProvider, type SolanaProvider } from '../client/solana-wallet.js';
import { approveExact, getAllowance, preflightPayment, sendPayment, sourceBalance, sourceNativeBalance, validateQuoteContext, walletAddressEquals } from '../client/wallets.js';

const keypair = Keypair.fromSeed(new Uint8Array(32).fill(71));
const other = Keypair.fromSeed(new Uint8Array(32).fill(72));
const blockhash = Keypair.fromSeed(new Uint8Array(32).fill(73)).publicKey.toBase58();
const source = keypair.publicKey.toBase58();
function quote(): Quote {
  const protocolOrderId = `0x${'ab'.repeat(32)}`;
  return { id: 'TEST_ONLY_SOLANA_QUOTE', routeId: SOLANA_ROUTE.id, sourceAddress: source, recipient: '0x1111111111111111111111111111111111111111', amount: '10.000001', amountBaseUnits: '10000001', expectedReceive: '9.9', minReceive: '9.8', expiresAt: new Date(Date.now() + 600_000).toISOString(), provider: 'Relay', protocolOrderId, fees: [], warnings: [], transaction: { kind: 'solana', chainId: SOLANA_ROUTE.sourceChainId, instructions: [buildSolanaDepositInstruction(source, '10000001', protocolOrderId)] } };
}
function wallet(name: 'Phantom' | 'Solflare' = 'Phantom') {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider: SolanaProvider = { isPhantom: name === 'Phantom', isSolflare: name === 'Solflare', publicKey: keypair.publicKey, isConnected: true,
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    signTransaction: vi.fn(async (tx: Transaction) => { tx.sign(keypair); return tx; }),
    on: (event, handler) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(handler); },
    removeListener: (event, handler) => { listeners.get(event)?.delete(handler); },
  };
  return { provider, emit: (event: string) => listeners.get(event)?.forEach(handler => handler()) };
}
function environment() {
  const phantom = wallet(); const solflare = wallet('Solflare');
  vi.stubGlobal('window', { phantom: { solana: phantom.provider }, solflare: solflare.provider });
  const state = { native: 100_000_000, tokens: 500_000_000n, fee: 5000 as number | null, genesis: SOLANA_GENESIS_HASH, blockhashValid: true, simulationError: null as unknown, tokenMint: SOLANA_USDC, tokenOwner: source, tokenState: 1, accountMissing: false, noSimulationAccount: false, afterSimulation: undefined as (() => void) | undefined, broadcastFailure: false, wrongBroadcastHash: false, events: [] as string[] };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.mainnet-beta.solana.com');
    const input = JSON.parse(String(init?.body)); let result: unknown;
    const accountData = Buffer.alloc(165); new PublicKey(state.tokenMint).toBuffer().copy(accountData, 0); new PublicKey(state.tokenOwner).toBuffer().copy(accountData, 32); accountData.writeBigUInt64LE(state.tokens, 64); accountData[108] = state.tokenState;
    const nativeAccount = { executable: false, owner: SystemProgram.programId.toBase58(), lamports: state.native, rentEpoch: 0, data: ['', 'base64'] };
    switch (input.method) {
      case 'getGenesisHash': result = state.genesis; break;
      case 'getAccountInfo': result = { context: { slot: 100 }, value: state.accountMissing ? null : { executable: false, owner: SOLANA_TOKEN_PROGRAM, lamports: 2039280, rentEpoch: 0, data: [accountData.toString('base64'), 'base64'] } }; break;
      case 'getBalance': result = { context: { slot: 100 }, value: state.native }; break;
      case 'getLatestBlockhash': result = { context: { slot: 100 }, value: { blockhash, lastValidBlockHeight: 300 } }; break;
      case 'getFeeForMessage': result = { context: { slot: 100 }, value: state.fee }; break;
      case 'simulateTransaction': state.afterSimulation?.(); result = { context: { slot: 100 }, value: { err: state.simulationError, logs: [], unitsConsumed: 25000, accounts: state.noSimulationAccount ? [null] : [nativeAccount] } }; break;
      case 'isBlockhashValid': result = { context: { slot: 100 }, value: state.blockhashValid }; break;
      case 'sendTransaction': {
        state.events.push('broadcast');
        expect(input.params[1]).toMatchObject({ preflightCommitment: 'confirmed', maxRetries: 0, encoding: 'base64' }); expect(input.params[1].skipPreflight).not.toBe(true);
        if (state.broadcastFailure) throw new Error('TEST_ONLY transport timeout');
        const sent = Transaction.from(Buffer.from(input.params[0], 'base64')); expect(sent.verifySignatures()).toBe(true);
        result = state.wrongBroadcastHash ? bs58.encode(new Uint8Array(64).fill(1)) : bs58.encode(sent.signature!); break;
      }
      default: throw new Error(`Unexpected isolated RPC ${input.method}`);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { ...phantom, phantom, solflare, state, fetchMock, sent: () => fetchMock.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === 'sendTransaction') };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Solana browser wallet execution and recovery boundary', () => {
  it('discovers passively and pins the selected provider without falling back', async () => {
    const env = environment(); expect(listSolanaWallets().map(value => value.name)).toEqual(['Phantom', 'Solflare']);
    expect(env.provider.connect).not.toHaveBeenCalled(); await connectSolana('solflare'); expect(solanaProvider()).toBe(env.solflare.provider);
    await expect(connectSolana('missing')).rejects.toThrow(/未检测/); expect(solanaProvider()).toBe(env.solflare.provider);
    await disconnectSolana(); expect(() => solanaProvider()).toThrow();
  });
  it('reads the exact USDC ATA and SOL balance without approval or signing', async () => {
    const env = environment(); await connectSolana(); const q = quote();
    expect(await sourceBalance(SOLANA_ROUTE, source)).toBe('500'); expect(await sourceNativeBalance(SOLANA_ROUTE, source)).toBe('0.1');
    expect(await getAllowance(q, SOLANA_ROUTE)).toBe(10000001n); await approveExact(q, SOLANA_ROUTE, vi.fn());
    expect(env.provider.signTransaction).not.toHaveBeenCalled(); expect(env.sent()).toHaveLength(0);
  });
  it('signs one exact legacy instruction and saves its signature before broadcasting once', async () => {
    const env = environment(); await connectSolana(); const q = quote(); let saved = '';
    const signature = await sendPayment(q, SOLANA_ROUTE, hash => { saved = hash; env.state.events.push('saved'); });
    expect(signature).toBe(saved); expect(bs58.decode(signature)).toHaveLength(64); expect(env.state.events).toEqual(['saved', 'broadcast']);
    expect(env.sent()).toHaveLength(1); expect(env.provider.signTransaction).toHaveBeenCalledOnce();
    const requested = vi.mocked(env.provider.signTransaction).mock.calls[0]![0];
    expect(requested.instructions).toHaveLength(1); expect(requested.feePayer!.toBase58()).toBe(source); expect(requested.recentBlockhash).toBe(blockhash);
    expect(requested.instructions[0]!.data.readBigUInt64LE(8)).toBe(10000001n);
  });
  it('stops before broadcasting if durable signature persistence fails', async () => {
    const env = environment(); await connectSolana();
    await expect(sendPayment(quote(), SOLANA_ROUTE, () => { throw new Error('TEST_ONLY storage unavailable'); })).rejects.toThrow(/storage/);
    expect(env.provider.signTransaction).toHaveBeenCalledOnce(); expect(env.sent()).toHaveLength(0);
  });
  it.each(['native-zero', 'native-low', 'token-low', 'unknown-fee', 'simulation', 'simulation-account', 'wrong-genesis', 'expired-blockhash', 'wrong-mint', 'wrong-owner', 'frozen-token'] as const)('blocks %s before signing', async failure => {
    const env = environment(); await connectSolana();
    if (failure === 'native-zero') env.state.native = 0;
    if (failure === 'native-low') env.state.native = 1;
    if (failure === 'token-low') env.state.tokens = 1n;
    if (failure === 'unknown-fee') env.state.fee = null;
    if (failure === 'simulation') env.state.simulationError = { InstructionError: [0, 'InsufficientFunds'] };
    if (failure === 'simulation-account') env.state.noSimulationAccount = true;
    if (failure === 'wrong-genesis') env.state.genesis = blockhash;
    if (failure === 'expired-blockhash') env.state.blockhashValid = false;
    if (failure === 'wrong-mint') env.state.tokenMint = other.publicKey.toBase58();
    if (failure === 'wrong-owner') env.state.tokenOwner = other.publicKey.toBase58();
    if (failure === 'frozen-token') env.state.tokenState = 2;
    await expect(sendPayment(quote(), SOLANA_ROUTE, vi.fn())).rejects.toThrow();
    expect(env.provider.signTransaction).not.toHaveBeenCalled(); expect(env.sent()).toHaveLength(0);
  });
  it.each(['account', 'disconnect', 'expiry'] as const)('rechecks %s after asynchronous preflight', async failure => {
    const env = environment(); await connectSolana(); const q = quote();
    env.state.afterSimulation = () => { if (failure === 'account') env.provider.publicKey = other.publicKey; if (failure === 'disconnect') env.emit('disconnect'); if (failure === 'expiry') q.expiresAt = '2000-01-01T00:00:00Z'; };
    await expect(sendPayment(q, SOLANA_ROUTE, vi.fn())).rejects.toThrow(); expect(env.provider.signTransaction).not.toHaveBeenCalled(); expect(env.sent()).toHaveLength(0);
  });
  it.each(['mutate-message', 'invalid-signature', 'changed-account', 'account-away-and-back', 'expired-quote', 'expired-blockhash'] as const)('rejects %s after wallet signing without broadcasting', async failure => {
    const env = environment(); await connectSolana(); const q = quote();
    vi.mocked(env.provider.signTransaction).mockImplementation(async tx => {
      if (failure === 'mutate-message') tx.add(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: other.publicKey, lamports: 1 }));
      tx.sign(keypair);
      if (failure === 'invalid-signature') tx.signatures[0]!.signature![0] ^= 1;
      if (failure === 'changed-account') env.provider.publicKey = other.publicKey;
      if (failure === 'account-away-and-back') { env.emit('accountChanged'); env.emit('accountChanged'); }
      if (failure === 'expired-quote') q.expiresAt = '2000-01-01T00:00:00Z';
      if (failure === 'expired-blockhash') env.state.blockhashValid = false;
      return tx;
    });
    const save = vi.fn(); await expect(sendPayment(q, SOLANA_ROUTE, save)).rejects.toThrow(); expect(env.sent()).toHaveLength(0); expect(save).not.toHaveBeenCalled();
  });
  it.each(['rejected', 'transport'] as const)('does not broadcast or retry a wallet %s error', async failure => {
    const env = environment(); await connectSolana(); vi.mocked(env.provider.signTransaction).mockRejectedValue(failure === 'rejected' ? { code: 4001 } : new Error('TEST_ONLY wallet timeout'));
    await expect(sendPayment(quote(), SOLANA_ROUTE, vi.fn())).rejects.toBeDefined(); expect(env.sent()).toHaveLength(0); expect(env.provider.signTransaction).toHaveBeenCalledOnce();
  });
  it.each(['rpc-failure', 'wrong-receipt'] as const)('preserves the signature for %s and never automatically retries broadcasting', async failure => {
    const env = environment(); await connectSolana(); env.state.broadcastFailure = failure === 'rpc-failure'; env.state.wrongBroadcastHash = failure === 'wrong-receipt'; const save = vi.fn();
    await expect(sendPayment(quote(), SOLANA_ROUTE, save)).rejects.toThrow(); expect(save).toHaveBeenCalledOnce(); expect(bs58.decode(save.mock.calls[0]![0])).toHaveLength(64); expect(env.sent()).toHaveLength(1);
  });
  it('never broadcasts a signature returned after the request has timed out', async () => {
    vi.useFakeTimers(); const env = environment(); await connectSolana(); let finish!: (value: Transaction) => void;
    vi.mocked(env.provider.signTransaction).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = sendPayment(quote(), SOLANA_ROUTE, vi.fn()); const rejection = expect(pending).rejects.toThrow(/超时/);
    await vi.waitFor(() => expect(env.provider.signTransaction).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(120_001); await rejection;
    const tx = vi.mocked(env.provider.signTransaction).mock.calls[0]![0]; tx.sign(keypair); finish(tx); await Promise.resolve(); await Promise.resolve();
    expect(env.sent()).toHaveLength(0);
  });
  it('rejects a substituted route and extra instruction before RPC, and preserves address case', async () => {
    const env = environment(); await connectSolana(); const q = quote();
    await expect(preflightPayment(q, { ...SOLANA_ROUTE, sourceToken: other.publicKey.toBase58() })).rejects.toThrow();
    if (q.transaction.kind !== 'solana') throw new Error('fixture'); q.transaction.instructions.push(q.transaction.instructions[0]!);
    expect(() => validateQuoteContext(q, SOLANA_ROUTE, source, q.recipient)).toThrow(); expect(env.fetchMock).not.toHaveBeenCalled();
    expect(walletAddressEquals(SOLANA_ROUTE, source, source.toLowerCase())).toBe(false);
  });
});
