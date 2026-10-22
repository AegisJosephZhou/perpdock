import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, ProviderQuote, QuoteRequest } from '../shared/types.js';
import { SOLANA_ROUTE, buildSolanaDepositInstruction } from '../shared/solana.js';
import { Store } from '../server/store.js';
import { OrderService } from '../server/order-service.js';
import { normalizeTxHash } from '../server/security.js';
import { createApp } from '../server/app.js';

// Synthetic keys/signatures and provider responses only; no network or wallet funds.
const source = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const signature = bs58.encode(new Uint8Array(64).fill(200));
const caseIndex = [...signature].findIndex((letter, index) => index > 8 && /[a-hjkmnp-z]/.test(letter));
const differentCase = signature.slice(0, caseIndex) + signature[caseIndex].toUpperCase() + signature.slice(caseIndex + 1);
const orderId = `0x${'a'.repeat(64)}`;
const request: QuoteRequest = { routeId: SOLANA_ROUTE.id, sourceAddress: source, recipient: `0x${'2'.repeat(40)}`, amount: '25' };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function setup(path = ':memory:') {
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [SOLANA_ROUTE]),
    getQuote: vi.fn(async (input): Promise<ProviderQuote> => ({ ...input, amountBaseUnits: '25000000', expectedReceive: '24.9', minReceive: '24',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), provider: 'TEST_ONLY', fees: [], warnings: [], protocolOrderId: orderId,
      transaction: { kind: 'solana', chainId: SOLANA_ROUTE.sourceChainId, instructions: [buildSolanaDepositInstruction(input.sourceAddress, '25000000', orderId)] },
      providerData: { requestId: orderId },
    })),
    verifySourceTransaction: vi.fn(async () => ({ valid: true, pending: false })),
    trackOrder: vi.fn(async () => ({ status: 'bridging' as const, statusMessage: 'TEST_ONLY_PENDING' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() })),
  };
  const store = new Store(path);
  const service = new OrderService(store, provider, { tokenSecret: 'TEST_ONLY_SECRET_01234567890123456789' });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await service.stop(); store.close(); } };
  cleanup.push(close);
  const create = async (key: string) => service.create((await service.quote(request)).id, key);
  return { provider, store, service, create, close };
}
function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dock-solana-service-test-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'test-only.sqlite');
}

describe('Solana order service and HTTP boundary', () => {
  it('keeps case-sensitive signatures and rejects noncanonical/wrong-length signatures', () => {
    expect(signature.length).toBeGreaterThan(66);
    expect(normalizeTxHash(signature, 'solana')).toBe(signature);
    expect(normalizeTxHash(differentCase, 'solana')).toBe(differentCase);
    expect(signature.toLowerCase()).toBe(differentCase.toLowerCase());
    for (const invalid of [`0x${'a'.repeat(64)}`, '0'.repeat(88), bs58.encode(new Uint8Array(63).fill(7)), signature + '1']) {
      expect(() => normalizeTxHash(invalid, 'solana')).toThrow('交易哈希格式');
    }
  });
  it('enforces exact signature uniqueness without conflating different base58 signatures', async () => {
    const env = setup(); const first = await env.create('solana-first-idempotency');
    const second = await env.create('solana-second-idempotency');
    await env.service.submit(first.order.id, first.accessToken, signature);
    await expect(env.service.submit(second.order.id, second.accessToken, signature)).rejects.toThrow('已关联其他订单');
    expect((await env.service.submit(second.order.id, second.accessToken, differentCase)).sourceTxHash).toBe(differentCase);
  });
  it('rejects invalid source keys and any instruction substitution before saving a quote', async () => {
    const env = setup();
    await expect(env.service.quote({ ...request, sourceAddress: request.recipient })).rejects.toThrow('来源钱包地址');
    const original = env.provider.getQuote;
    env.provider.getQuote = async input => {
      const result = await original(input);
      if (result.transaction.kind === 'solana') result.transaction.instructions[0].keys[5].pubkey = source;
      return result;
    };
    await expect(env.service.quote(request)).rejects.toThrow('Solana 交易参数');
  });
  it('retains pending signatures without marking the order funded', async () => {
    const env = setup(); const first = await env.create('solana-pending-idempotency');
    env.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: true }));
    const order = await env.service.submit(first.order.id, first.accessToken, signature);
    expect(order.sourceTxHash).toBe(signature);
    expect(order.status).toBe('source_pending');
    expect(order.creditedAmount).toBeUndefined();
    await expect(env.service.submit(first.order.id, first.accessToken, differentCase)).rejects.toThrow('不能覆盖');
  });
  it('recovers the exact pending signature after SQLite reopen and retries only its verification', async () => {
    const path = temporaryDatabase();
    const initial = setup(path); const saved = await initial.create('solana-restart-pending');
    initial.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: true }));
    await initial.service.submit(saved.order.id, saved.accessToken, signature);
    await initial.close();

    const reopened = setup(path);
    reopened.provider.verifySourceTransaction = vi.fn(async () => { throw new Error('TEST_ONLY RPC unavailable'); });
    const recovered = await reopened.service.get(saved.order.id, saved.accessToken);
    expect(recovered.sourceTxHash).toBe(signature);
    expect(recovered.quote.sourceAddress).toBe(source);
    expect(recovered.status).toBe('source_pending');
    const unavailable = await reopened.service.refresh(saved.order.id, saved.accessToken);
    expect(unavailable).toMatchObject({ sourceTxHash: signature, status: 'source_pending', trackingCheck: { result: 'unavailable' } });
    expect(reopened.provider.verifySourceTransaction).toHaveBeenCalledWith(expect.objectContaining({ sourceAddress: source }), signature);
    expect(reopened.provider.trackOrder).not.toHaveBeenCalled();
    expect(reopened.provider.getQuote).not.toHaveBeenCalled();
    await expect(reopened.service.submit(saved.order.id, saved.accessToken, differentCase)).rejects.toThrow('不能覆盖');

    reopened.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    const verified = await reopened.service.refresh(saved.order.id, saved.accessToken);
    expect(verified).toMatchObject({ sourceTxHash: signature, status: 'bridging', trackingCheck: { result: 'ok' } });
    expect(verified.creditedAmount).toBeUndefined();
    expect(reopened.provider.trackOrder).toHaveBeenCalledOnce();
  });
  it('preserves verified completion and signature ownership across SQLite reopen', async () => {
    const path = temporaryDatabase();
    const initial = setup(path); const saved = await initial.create('solana-restart-completed');
    const destinationTxHash = `0x${'c'.repeat(64)}`;
    initial.provider.trackOrder = vi.fn(async () => ({ status: 'completed' as const, statusMessage: 'TEST_ONLY verified destination credit',
      destinationTxHash, creditedAmount: '24.9', evidence: [{ type: 'hypercore_credit', reference: `${request.recipient}:${destinationTxHash}` }] }));
    await initial.service.submit(saved.order.id, saved.accessToken, signature);
    const completed = await initial.service.refresh(saved.order.id, saved.accessToken);
    expect(completed.status).toBe('completed');
    await initial.close();

    const reopened = setup(path);
    reopened.provider.verifySourceTransaction = vi.fn(async () => ({ valid: false, reason: 'TEST_ONLY must never be queried after completion' }));
    reopened.provider.trackOrder = vi.fn(async () => ({ status: 'attention' as const, statusMessage: 'TEST_ONLY stale tracking response' }));
    expect(await reopened.service.get(saved.order.id, saved.accessToken)).toEqual(completed);
    expect(await reopened.service.refresh(saved.order.id, saved.accessToken)).toEqual(completed);
    expect(await reopened.service.submit(saved.order.id, saved.accessToken, signature)).toEqual(completed);
    await expect(reopened.service.submit(saved.order.id, saved.accessToken, differentCase)).rejects.toThrow('不能覆盖');
    expect(reopened.provider.verifySourceTransaction).not.toHaveBeenCalled();
    expect(reopened.provider.trackOrder).not.toHaveBeenCalled();
    expect(reopened.store.dueOrders(Date.now() + 60_000)).toEqual([]);

    const another = await reopened.create('solana-restart-second-order');
    reopened.provider.verifySourceTransaction = vi.fn(async () => ({ valid: true, pending: false }));
    await expect(reopened.service.submit(another.order.id, another.accessToken, signature)).rejects.toThrow('已关联其他订单');
    expect(await reopened.service.get(saved.order.id, saved.accessToken)).toEqual(completed);
  });
  it('accepts a full 88-character signature through the authenticated API and allows only the fixed Solana RPC in CSP', async () => {
    const env = setup(); const first = await env.create('solana-http-idempotency');
    const server = createApp(env.service, { allowedOrigins: ['https://dock.example'], logging: false }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orders/${first.order.id}/transaction`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${first.accessToken}`, origin: 'https://dock.example' }, body: JSON.stringify({ txHash: signature }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).sourceTxHash).toBe(signature);
    expect(response.headers.get('content-security-policy')).toContain('https://api.mainnet-beta.solana.com');
    expect(response.headers.get('content-security-policy')).not.toContain('https:;');
  });
});
