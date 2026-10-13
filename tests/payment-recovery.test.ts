import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, loadSavedOrders, persistSavedOrder, savedOrderForPayment, STORAGE_KEY, SUBMISSION_PREFIX, withOrderPaymentLock, type SavedOrder } from '../client/api.js';
import { executeOrderPayment } from '../client/payment.js';
import type { Order } from '../shared/types.js';

const txHash = 'ab'.repeat(32);
const saved: SavedOrder = { id: 'recovery-order', accessToken: 'local-test-access-token', createdAt: '2026-10-12T00:00:00.000Z' };
const order: Order = {
  id: saved.id, createdAt: saved.createdAt, updatedAt: saved.createdAt, status: 'awaiting_signature', statusMessage: '等待签名', events: [],
  quote: { id: 'quote-current', routeId: 'tron-usdt-hypercore', amount: '10', amountBaseUnits: '10000000', sourceAddress: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7', recipient: '0x1111111111111111111111111111111111111111', expectedReceive: '9.9', minReceive: '9.8', expiresAt: '2099-01-01T00:00:00.000Z', provider: 'Relay', fees: [], warnings: [], transaction: { kind: 'tron', transaction: {} } },
};
class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Flow = Parameters<typeof executeOrderPayment>[0];
function flow(overrides: Partial<Flow> = {}): Flow {
  return {
    saved, expectedQuoteId: order.quote.id, validate: vi.fn(),
    sign: vi.fn(async (_quote, onHash) => { onHash(txHash); return txHash; }),
    onSaved: vi.fn(), onOrder: vi.fn(), onProgress: vi.fn(), ...overrides,
  };
}
let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: { request: async (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => {
    expect(options).toEqual({ mode: 'exclusive', ifAvailable: true });
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: 'exclusive' } as Lock); }
    finally { held.delete(name); }
  } } });
  persistSavedOrder(saved);
  vi.spyOn(api, 'order').mockResolvedValue(structuredClone(order));
  vi.spyOn(api, 'report').mockResolvedValue({ ...structuredClone(order), status: 'source_pending', sourceTxHash: txHash });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('payment concurrency and durable recovery', () => {
  it('admits only one signer while two tabs race the same order', async () => {
    const gate = deferred<string>();
    const reachedSigner = deferred<void>();
    const first = flow({ sign: vi.fn(async (_quote, onHash) => { reachedSigner.resolve(); const hash = await gate.promise; onHash(hash); return hash; }) });
    const second = flow();
    const running = executeOrderPayment(first);
    await reachedSigner.promise;
    await expect(executeOrderPayment(second)).rejects.toThrow(/另一个标签页/);
    expect(second.sign).not.toHaveBeenCalled();
    gate.resolve(txHash); await running;
    expect(first.sign).toHaveBeenCalledTimes(1);
    await expect(executeOrderPayment(second)).rejects.toThrow(/已有付款操作记录/);
    expect(second.sign).not.toHaveBeenCalled();
  });

  it('does not serialize unrelated order locks', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const first = withOrderPaymentLock('first', async () => { entered.resolve(); await gate.promise; });
    await entered.promise;
    await expect(withOrderPaymentLock('second', async () => 'ok')).resolves.toBe('ok');
    gate.resolve(); await first;
  });

  it('records durable signing intent before asking the wallet and records hash before reporting', async () => {
    const next = flow({ sign: vi.fn(async (_quote, onHash) => {
      expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'signing' });
      onHash(txHash);
      expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'submitted', txHash });
      return txHash;
    }) });
    await executeOrderPayment(next);
    expect(api.report).toHaveBeenCalledWith(saved.id, saved.accessToken, txHash);
  });

  it.each(['signing', 'unknown', 'submitted'] as const)('blocks a fresh tab from repeating a stored %s payment', async (state) => {
    persistSavedOrder({ ...saved, submission: { state, ...(state === 'submitted' ? { txHash } : {}) } });
    const resumed = loadSavedOrders()[0]!;
    const next = flow({ saved: resumed });
    await expect(executeOrderPayment(next)).rejects.toThrow(/已有付款操作记录/);
    expect(api.order).not.toHaveBeenCalled(); expect(next.sign).not.toHaveBeenCalled();
  });

  it('preserves a broadcast hash after reporting fails and prevents a second signature after refresh', async () => {
    vi.mocked(api.report).mockRejectedValue(new Error('network unavailable'));
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/交易编号已保留/);
    const resumed = loadSavedOrders()[0]!;
    expect(resumed.submission).toEqual({ state: 'unknown', txHash });
    const retry = flow({ saved: resumed });
    await expect(executeOrderPayment(retry)).rejects.toThrow(/已有付款操作记录/);
    expect(retry.sign).not.toHaveBeenCalled(); expect(next.sign).toHaveBeenCalledTimes(1);
  });

  it('retains unknown state when a wallet times out without returning a hash', async () => {
    const next = flow({ sign: vi.fn().mockRejectedValue(new Error('wallet transport timeout')) });
    await expect(executeOrderPayment(next)).rejects.toThrow(/付款结果尚不确定/);
    expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'unknown' });
    const retry = flow();
    await expect(executeOrderPayment(retry)).rejects.toThrow(/已有付款操作记录/);
    expect(retry.sign).not.toHaveBeenCalled();
  });

  it('allows retry after an explicit pre-broadcast wallet rejection', async () => {
    const rejected = flow({ sign: vi.fn().mockRejectedValue(new Error('Confirmation declined by user')) });
    await expect(executeOrderPayment(rejected)).rejects.toThrow(/declined/);
    expect(savedOrderForPayment(saved.id)?.submission).toBeUndefined();
    const retry = flow(); await executeOrderPayment(retry);
    expect(retry.sign).toHaveBeenCalledTimes(1);
  });

  it.each(['marker', 'list'])('never signs when the %s storage write fails', async (part) => {
    const write = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === (part === 'marker' ? `${SUBMISSION_PREFIX}${saved.id}` : STORAGE_KEY)) throw new Error('QuotaExceededError');
      write(key, value);
    });
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/QuotaExceeded/);
    expect(next.sign).not.toHaveBeenCalled(); expect(api.report).not.toHaveBeenCalled();
    if (part === 'list') expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'signing' });
  });

  it('does not treat unavailable storage as permission to pay again', async () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/无法完整读取/);
    expect(next.sign).not.toHaveBeenCalled(); expect(api.order).not.toHaveBeenCalled();
  });

  it('retains the per-order marker even if another tab overwrites the recent-order row with stale data', async () => {
    persistSavedOrder({ ...saved, submission: { state: 'submitted', txHash } });
    storage.setItem(STORAGE_KEY, JSON.stringify([{ id: 'other-order', accessToken: 'other-token', createdAt: saved.createdAt }, saved]));
    expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'submitted', txHash });
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/已有付款操作记录/);
    expect(next.sign).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'source_pending' as const, sourceTxHash: txHash },
    { status: 'awaiting_signature' as const, sourceTxHash: txHash },
    { status: 'expired' as const },
    { quote: { ...order.quote, id: 'another-quote' } },
  ])('re-reads the server and rejects a stale payable screen: %j', async (change) => {
    vi.mocked(api.order).mockResolvedValue({ ...structuredClone(order), ...change });
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/订单状态已变化/);
    expect(next.sign).not.toHaveBeenCalled(); expect(savedOrderForPayment(saved.id)?.submission).toBeUndefined();
  });

  it('leaves no payment attempt after a failed order read and permits a later safe retry', async () => {
    vi.mocked(api.order).mockRejectedValueOnce(new Error('server unavailable'));
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/server unavailable/);
    expect(savedOrderForPayment(saved.id)?.submission).toBeUndefined();
    await executeOrderPayment(next); expect(next.sign).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/无法安全锁定付款/);
    expect(next.sign).not.toHaveBeenCalled();
  });

  it('fails closed on a corrupt independent recovery marker', async () => {
    storage.setItem(`${SUBMISSION_PREFIX}${saved.id}`, JSON.stringify({ state: 'pretend-new' }));
    const next = flow();
    await expect(executeOrderPayment(next)).rejects.toThrow(/无法完整读取/);
    expect(next.sign).not.toHaveBeenCalled();
  });
});
