import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startAttribution, getQuoteAttribution } from '../client/attribution.js';
import { api } from '../client/api.js';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const config = { enabled: true as const, campaigns: ['x_en_launch', 'partner_demo'] };
const query = '?utm_source=x&utm_medium=organic_social&utm_campaign=x_en_launch&private=DO_NOT_SEND';
beforeEach(() => {
  vi.stubGlobal('sessionStorage', new MemoryStorage());
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Payment storage must not be read'); } });
  vi.stubGlobal('window', { location: { search: query } });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ accepted: true }) })));
  startAttribution(undefined, 'zh');
});
afterEach(() => { startAttribution(undefined, 'zh'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('non-blocking browser attribution', () => {
  it('does nothing without enabled config, ignores unknown campaigns and duplicate query labels', () => {
    expect(getQuoteAttribution()).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    window.location.search = '?utm_source=x&utm_medium=organic_social&utm_campaign=unapproved';
    startAttribution(config, 'en');
    expect(fetch).not.toHaveBeenCalled();
    window.location.search = `${query}&utm_campaign=x_en_launch`;
    startAttribution(config, 'en');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains one first-touch session through repeated effects, language switch and another campaign', () => {
    startAttribution(config, 'en');
    const first = getQuoteAttribution();
    expect(first).toMatchObject({ campaign: 'x_en_launch', source: 'x', medium: 'organic_social', lang: 'en' });
    expect(first?.sessionId).toMatch(/^[\da-f-]{36}$/);
    window.location.search = '?utm_source=partner&utm_medium=referral&utm_campaign=partner_demo';
    startAttribution(config, 'zh'); startAttribution(config, 'zh');
    expect(getQuoteAttribution()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(fetch).mock.calls[0];
    expect(String(options?.body)).not.toContain('DO_NOT_SEND');
    expect(JSON.parse(String(options?.body))).toEqual(first);
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
  });
  it('uses an in-memory fallback and never propagates storage or network failures into quotation', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'quote-test' }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(() => startAttribution(config, 'en')).not.toThrow();
    await expect(api.quote({ routeId: 'route', amount: '100', sourceAddress: 'source', recipient: 'recipient' })).resolves.toEqual({ id: 'quote-test' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).attribution).toMatchObject({ campaign: 'x_en_launch' });
  });
  it('removes only its own stored data when disabled and omits attribution from subsequent quotes', async () => {
    sessionStorage.setItem('unrelated', 'preserve');
    startAttribution(config, 'en');
    startAttribution(undefined, 'en');
    expect(getQuoteAttribution()).toBeUndefined();
    expect(sessionStorage.getItem('unrelated')).toBe('preserve');
    expect(sessionStorage.getItem('dock.attribution.v1')).toBeNull();
    await api.quote({ routeId: 'route', amount: '100', sourceAddress: 'source', recipient: 'recipient' });
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body));
    expect(body.attribution).toBeUndefined();
  });
  it('expires a tab session and obtains a new random id without reusing the old cohort', () => {
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now);
    startAttribution(config, 'en'); const first = getQuoteAttribution();
    vi.mocked(Date.now).mockReturnValue(now + 31 * 60_000);
    const second = getQuoteAttribution();
    expect(second?.sessionId).not.toBe(first?.sessionId);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('restores the persisted tab session after a module reload and direct return without UTM', async () => {
    startAttribution(config, 'en');
    const first = getQuoteAttribution();
    window.location.search = '';
    vi.resetModules();
    const reloaded = await import('../client/attribution.js');
    // App waits for config before calling this; loading is not an explicit disable action.
    expect(sessionStorage.getItem('dock.attribution.v1')).not.toBeNull();
    reloaded.startAttribution(config, 'zh');
    expect(reloaded.getQuoteAttribution()).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(2); // Same ID; server deduplicates repeated landing delivery.
    reloaded.startAttribution(undefined, 'zh');
  });
});
