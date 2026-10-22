// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMonitoring, configureBrowserMonitoring, flushBrowserMonitoring, MonitoringErrorBoundary,
  safeBrowserLocation, safeBrowserStackLocation } from '../client/observability.js';
import { api } from '../client/api.js';
import { monitoringConfiguration, type MonitoringReporter } from '../shared/observability.js';

const config = monitoringConfiguration('true', `https://${'b'.repeat(32)}@o123.ingest.us.sentry.io/456`, 'staging', '884143d')!;
const cleanups: MonitoringReporter[] = [];
let fetchImplementation: typeof fetch;
// The SDK caches native fetch. Keep one proxy while each test supplies an isolated destination.
const fetchProxy: typeof fetch = (input, options) => fetchImplementation(input, options);
afterEach(async () => { configureBrowserMonitoring(undefined); for (const reporter of cleanups.splice(0)) await reporter.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('browser error privacy and diagnostics', () => {
  it('keeps only same-origin entry bundle line/column and removes the entire URL and query', () => {
    const expected = { file: 'app:///assets/index.js', line: 12, column: 34 };
    expect(safeBrowserLocation('https://dock.example/assets/index-aB123456.js?token=SECRET#private', 12, 34, 'https://dock.example')).toEqual(expected);
    for (const url of ['https://evil.invalid/assets/index-aB123456.js', 'https://dock.example/orders/private.js',
      'https://dock.example/assets/private-wallet-address.js', 'chrome-extension://id/assets/index-aB123456.js']) {
      expect(safeBrowserLocation(url, 12, 34, 'https://dock.example')).toBeUndefined();
    }
    expect(safeBrowserLocation('https://dock.example/assets/index-aB123456.js', Infinity, 2, 'https://dock.example')).toBeUndefined();
    const error = { stack: 'Error: SECRET wallet 0x123\n at secretFunction (https://dock.example/assets/index-aB123456.js?token=SECRET:12:34)' };
    expect(safeBrowserStackLocation(error, 'https://dock.example')).toEqual(expected);
    expect(safeBrowserStackLocation({ get stack() { throw new Error('SECRET'); } }, 'https://dock.example')).toBeUndefined();
  });
  it('uses the real browser SDK with a local transport and emits a synthetic safe stack frame', async () => {
    const envelopes: unknown[] = [];
    const reporter = createBrowserMonitoring(config, { transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
    cleanups.push(reporter);
    reporter.report({ stage: 'window_error', route: '/', code: 'WINDOW_ERROR', location: { file: 'app:///assets/index.js', line: 12, column: 34 } });
    await reporter.flush();
    const serialized = JSON.stringify(envelopes);
    expect(envelopes).toHaveLength(1); expect(serialized).toContain('app:///assets/index.js');
    expect(serialized).toContain('"lineno":12'); expect(serialized).toContain('884143d');
    expect(serialized).not.toContain('http://localhost'); expect(serialized).not.toContain('user_agent');
  });
  it('keeps the app working when the reporting transport cannot be constructed', () => {
    const reporter = createBrowserMonitoring(config, { transport: () => { throw new Error('transport down'); } });
    expect(reporter.enabled).toBe(false);
    expect(() => reporter.report({ stage: 'client_api', code: 'HTTP_ERROR' })).not.toThrow();
  });
});

describe('browser hooks and API integration', () => {
  function network() {
    const envelopes: string[] = [];
    const send = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      const target = String(url);
      if (target.startsWith('https://o123.ingest.us.sentry.io/')) {
        envelopes.push(typeof options?.body === 'string' ? options.body : new TextDecoder().decode(options?.body as Uint8Array));
        return new Response('', { status: 200 });
      }
      if (target === '/api/config') return new Response(JSON.stringify({ monitoring: config }), { status: 200 });
      if (target.startsWith('/api/orders/')) return new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'SECRET raw error', requestId: '12345678-1234-4123-8123-123456789abc' } }), { status: 503 });
      throw new TypeError('SECRET network URL');
    });
    fetchImplementation = send;
    vi.stubGlobal('fetch', fetchProxy);
    return { envelopes, send };
  }
  it('reports API failure without addresses, tokens or original error text and preserves the caller error', async () => {
    const { envelopes } = network();
    await api.config();
    await expect(api.order('SECRET_ORDER_ID', 'SECRET_BEARER_TOKEN')).rejects.toThrow('SECRET raw error');
    await flushBrowserMonitoring();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toContain('/api/orders/:id');
    expect(envelopes[0]).toContain('12345678-1234-4123-8123-123456789abc');
    expect(envelopes[0]).not.toContain('SECRET');
  });
  it('registers hooks once, reports safe window/rejection events, and removes hooks on disable', async () => {
    const { envelopes } = network();
    const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener');
    configureBrowserMonitoring(config); configureBrowserMonitoring(config);
    expect(add.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);
    expect(add.mock.calls.filter(([type]) => type === 'unhandledrejection')).toHaveLength(1);
    window.dispatchEvent(new ErrorEvent('error', { message: 'SECRET wallet amount', filename: `${window.location.origin}/assets/index-aB123456.js?token=SECRET`, lineno: 2, colno: 9 }));
    const rejection = new Event('unhandledrejection'); Object.defineProperty(rejection, 'reason', { value: { token: 'SECRET' } });
    window.dispatchEvent(rejection);
    await flushBrowserMonitoring();
    expect(envelopes).toHaveLength(2); expect(envelopes.join('\n')).not.toContain('SECRET');
    expect(envelopes.join('\n')).toContain('app:///assets/index.js');
    configureBrowserMonitoring(undefined);
    expect(remove.mock.calls.filter(([type]) => type === 'error')).toHaveLength(1);
    window.dispatchEvent(new ErrorEvent('error', { message: 'SECRET' }));
    await flushBrowserMonitoring(); expect(envelopes).toHaveLength(2);
  });
  it('shows a safe recovery boundary without clearing local payment data or showing the original error', async () => {
    const { envelopes } = network(); configureBrowserMonitoring(config);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    const clear = vi.spyOn(Storage.prototype, 'clear'); const remove = vi.spyOn(Storage.prototype, 'removeItem');
    function Broken(): never { const error = new Error('SECRET order token'); error.stack = `Error: SECRET\n at privateFunction (${window.location.origin}/assets/index-aB123456.js?token=SECRET:5:6)`; throw error; }
    try {
      await act(async () => root.render(<MonitoringErrorBoundary><Broken /></MonitoringErrorBoundary>));
      await flushBrowserMonitoring();
      expect(host.textContent).not.toContain('SECRET'); expect(host.textContent).toMatch(/不要再次付款|do not pay again/);
      expect(clear).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      expect(envelopes).toHaveLength(1); expect(envelopes[0]).toContain('REACT_RENDER_ERROR'); expect(envelopes[0]).not.toContain('SECRET');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
