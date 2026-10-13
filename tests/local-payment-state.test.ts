import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSavedOrders, persistSavedOrder, readLocalPaymentState, STORAGE_KEY, SUBMISSION_PREFIX, type SavedOrder } from '../client/api.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
}
const saved = (id: string): SavedOrder => ({ id, accessToken: `TEST_ONLY_${id}`, createdAt: '2026-10-12T00:00:00Z' });
beforeEach(() => vi.stubGlobal('localStorage', new MemoryStorage()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('strict browser payment recovery state', () => {
  it('merges durable payment markers independently of the order list', () => {
    persistSavedOrder(saved('a'));
    localStorage.setItem(`${SUBMISSION_PREFIX}a`, JSON.stringify({ state: 'unknown', txHash: 'ab'.repeat(32) }));
    const result = readLocalPaymentState();
    expect(result.orders[0]?.submission?.state).toBe('unknown');
    expect(result.orphanedIds).toEqual([]);
  });
  it('reports orphaned payment markers without deleting them or claiming no history', () => {
    localStorage.setItem(`${SUBMISSION_PREFIX}lost`, JSON.stringify({ state: 'signing' }));
    expect(readLocalPaymentState().orphanedIds).toEqual(['lost']);
    persistSavedOrder(saved('new'));
    expect(readLocalPaymentState().orphanedIds).toEqual(['lost']);
  });
  it.each(['', '{bad', '{}', '[null]', '[{"id":"a"}]'])('fails closed for malformed saved orders: %s', (raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    expect(() => readLocalPaymentState()).toThrow(/无法完整读取/);
    expect(() => persistSavedOrder(saved('new'))).toThrow(/无法完整读取/);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });
  it.each(['', '{broken', '{"state":"completed"}', '{"state":"unknown","txHash":4}'])('fails closed for malformed standalone markers: %s', (raw) => {
    localStorage.setItem(`${SUBMISSION_PREFIX}lost`, raw);
    expect(() => readLocalPaymentState()).toThrow(/无法完整读取/);
  });
  it('does not discard payment recovery when many unsigned orders are later saved', () => {
    persistSavedOrder({ ...saved('pending'), submission: { state: 'unknown' } });
    for (let index = 0; index < 30; index++) persistSavedOrder(saved(`unsigned-${index}`));
    const state = readLocalPaymentState();
    expect(state.orders.some(item => item.id === 'pending' && item.submission?.state === 'unknown')).toBe(true);
    expect(state.orders.filter(item => !item.submission)).toHaveLength(20);
    expect(loadSavedOrders().some(item => item.id === 'pending')).toBe(true);
    expect(state.orphanedIds).toEqual([]);
  });
  it('reads all legacy records without truncating pending records beyond position 20', () => {
    const entries = Array.from({ length: 25 }, (_, index) => saved(`old-${index}`));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    localStorage.setItem(`${SUBMISSION_PREFIX}old-24`, '{"state":"submitted"}');
    expect(readLocalPaymentState().orders).toHaveLength(25);
    expect(loadSavedOrders().find(item => item.id === 'old-24')?.submission?.state).toBe('submitted');
  });
  it('rejects duplicate credentials and malformed inline payment records', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([saved('same'), saved('same')]));
    expect(() => readLocalPaymentState()).toThrow();
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...saved('a'), submission: { state: 'done' } }]));
    expect(() => readLocalPaymentState()).toThrow();
  });
  it('cannot treat storage read denial as a clean payment state', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('TEST_ONLY storage denied'); });
    expect(() => readLocalPaymentState()).toThrow(/无法完整读取/);
    expect(() => persistSavedOrder(saved('new'))).toThrow();
  });
});
