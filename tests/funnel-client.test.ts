import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQuoteFunnel, reportOrderStage, startFunnel, trackFunnel } from '../client/funnel.js';
import { api, persistSavedOrder, savedOrderForPayment } from '../client/api.js';
import { executeOrderPayment } from '../client/payment.js';
import type { Order } from '../shared/types.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const saved = { id: 'test-order', accessToken: 'sensitive-access-token', createdAt: '2026-10-22T22:00:00.000Z' };
const order: Order = { id: saved.id, createdAt: saved.createdAt, updatedAt: saved.createdAt, status: 'awaiting_signature', statusMessage: '', events: [],
  quote: { id: 'test-quote', routeId: 'solana-usdc-hypercore', amount: '10', amountBaseUnits: '10000000', sourceAddress: 'sensitive-source',
    recipient: 'sensitive-recipient', expectedReceive: '9.9', minReceive: '9.8', expiresAt: '2099-01-01T00:00:00.000Z', provider: 'TEST', fees: [], warnings: [],
    transaction: { kind: 'solana', chainId: 792703809, instructions: [] } } };
const hash = 'sensitive-solana-signature';
beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemoryStorage()); vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('window', { location: { search: '?private=do-not-send', href: 'https://private.example/?secret=1' } });
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, action: (lock: unknown) => unknown) => action({}) } });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  startFunnel(undefined, 'zh');
});
afterEach(() => { startFunnel(undefined, 'zh'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const bodies = (part: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes(part)).map(([, init]) => JSON.parse(String(init?.body)));
type Flow = Parameters<typeof executeOrderPayment>[0];
function flow(sign: Flow['sign']): Flow {
  return { saved, expectedQuoteId: order.quote.id, sign, validate: vi.fn(), onSaved: vi.fn(), onOrder: vi.fn(), onProgress: vi.fn() };
}
function paymentSetup() {
  persistSavedOrder(saved);
  vi.spyOn(api, 'order').mockResolvedValue(structuredClone(order));
  vi.spyOn(api, 'report').mockResolvedValue({ ...structuredClone(order), status: 'source_pending', sourceTxHash: hash });
  startFunnel({ enabled: true }, 'en');
}

describe('anonymous browser collection', () => {
  it('does not collect by default, requires no UTM, and preserves session through rerenders without reading URLs', () => {
    expect(getQuoteFunnel()).toBeUndefined(); trackFunnel('landing'); expect(fetch).not.toHaveBeenCalled();
    startFunnel({ enabled: true }, 'en'); const first = getQuoteFunnel();
    startFunnel({ enabled: true }, 'zh'); const second = getQuoteFunnel();
    expect(second?.sessionId).toBe(first?.sessionId); expect(second?.lang).toBe('en');
    expect(second?.attemptId).not.toBe(first?.attemptId); expect(fetch).toHaveBeenCalledTimes(1);
    expect(Object.keys(bodies('/events')[0]).sort()).toEqual(['attemptId', 'event', 'eventId', 'lang', 'sessionId']);
    expect(JSON.stringify(bodies('/events'))).not.toContain('private');
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ referrerPolicy: 'no-referrer', credentials: 'omit' });
  });
  it('rotates stale sessions, tolerates broken storage/network, and only removes its own session key', () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    sessionStorage.setItem('payment-unrelated', 'preserve'); startFunnel({ enabled: true }, 'en');
    const first = getQuoteFunnel(); vi.mocked(Date.now).mockReturnValue(now + 31 * 60_000);
    expect(getQuoteFunnel()?.sessionId).not.toBe(first?.sessionId);
    startFunnel(undefined, 'en'); expect(sessionStorage.getItem('payment-unrelated')).toBe('preserve');
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    vi.mocked(fetch).mockRejectedValue(new Error('offline secret'));
    expect(() => startFunnel({ enabled: true }, 'en')).not.toThrow(); expect(getQuoteFunnel()?.sessionId).toBeTruthy();
  });
  it.each(['quote', 'event'] as const)('emits one new landing on an expired long-open tab before direct %s usage', (usage) => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    startFunnel({ enabled: true }, 'en'); const original = getQuoteFunnel()!;
    vi.mocked(Date.now).mockReturnValue(now + 31 * 60_000);
    if (usage === 'quote') getQuoteFunnel();
    else trackFunnel('wallet_connect_started');
    const next = getQuoteFunnel()!;
    const landings = bodies('/events').filter(body => body.event === 'landing');
    expect(landings.map(body => body.sessionId)).toEqual([original.sessionId, next.sessionId]);
    expect(next.sessionId).not.toBe(original.sessionId);
    if (usage === 'event') expect(bodies('/events').slice(-2).map(body => body.event)).toEqual(['landing', 'wallet_connect_started']);
    getQuoteFunnel(); trackFunnel('landing'); startFunnel({ enabled: true }, 'en');
    expect(bodies('/events').filter(body => body.event === 'landing')).toHaveLength(2);
  });
  it('operational stage reporting works with analytics disabled, retries same ID, never sends a hash', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('lost')).mockResolvedValue(new Response('{}', { status: 200 }));
    reportOrderStage(saved, 'signing'); await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(bodies('/stage')[0]).toEqual(bodies('/stage')[1]);
    expect(Object.keys(bodies('/stage')[0]).sort()).toEqual(['eventId', 'observedAt', 'stage']);
    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ Authorization: `Bearer ${saved.accessToken}` });
    expect(bodies('/events')).toEqual([]);
  });
});

describe('payment observation cannot weaken recovery', () => {
  it('does not call a pre-broadcast Solana hash a broadcast; unknown results keep the saved hash', async () => {
    paymentSetup();
    const sign = vi.fn<Flow['sign']>(async (_quote, onHash) => {
      onHash(hash);
      expect(bodies('/stage').map(body => body.stage)).toEqual(['signing']);
      throw new Error('RPC result unknown; sensitive raw details');
    });
    await expect(executeOrderPayment(flow(sign))).rejects.toThrow('交易编号已保留');
    expect(bodies('/stage').map(body => body.stage)).toEqual(['signing']);
    expect(bodies('/events').map(body => body.event)).toContain('payment_reference_observed');
    expect(bodies('/events').map(body => body.event)).toContain('payment_outcome_unknown');
    expect(bodies('/events').map(body => body.event)).not.toContain('signing_failed');
    expect(savedOrderForPayment(saved.id)?.submission).toEqual({ state: 'unknown', txHash: hash });
    await expect(executeOrderPayment(flow(sign))).rejects.toThrow('已有付款操作记录'); expect(sign).toHaveBeenCalledTimes(1);
    for (const secret of [hash, saved.accessToken, order.quote.sourceAddress, order.quote.recipient, 'sensitive raw details']) {
      expect(JSON.stringify(bodies('/events'))).not.toContain(secret); expect(JSON.stringify(bodies('/stage'))).not.toContain(secret);
    }
  });
  it('reports broadcast only after send returned; a report failure is not signing failure or completion', async () => {
    paymentSetup(); vi.mocked(api.report).mockRejectedValue(new Error('report unavailable'));
    await expect(executeOrderPayment(flow(async (_quote, onHash) => { onHash(hash); return hash; }))).rejects.toThrow('交易编号已保留');
    expect(bodies('/stage').map(body => body.stage)).toEqual(['signing', 'broadcast']);
    expect(bodies('/events').map(body => body.event)).toContain('source_report_failed');
    expect(bodies('/events').map(body => body.event)).not.toContain('signing_failed');
    expect(savedOrderForPayment(saved.id)?.submission?.state).toBe('unknown');
  });
  it('hanging or throwing analytics cannot prevent the wallet flow and explicit rejection remains safely retryable', async () => {
    paymentSetup(); vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    await expect(executeOrderPayment(flow(async (_quote, onHash) => { onHash(hash); return hash; }))).resolves.toBeUndefined();
    expect(api.report).toHaveBeenCalledExactlyOnceWith(saved.id, saved.accessToken, hash);
    localStorage.clear(); persistSavedOrder(saved); vi.mocked(fetch).mockImplementation(() => { throw new Error('blocked'); });
    await expect(executeOrderPayment(flow(async () => { throw new Error('Confirmation declined by user'); }))).rejects.toThrow('declined');
    expect(savedOrderForPayment(saved.id)?.submission).toBeUndefined();
  });
});
