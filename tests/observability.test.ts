import { afterEach, describe, expect, it } from 'vitest';
import { getGlobalScope } from '@sentry/node';
import { createServerMonitoring } from '../server/observability.js';
import { apiRouteTemplate, monitoringBudget, monitoringConfiguration, monitoringEvent, publicMonitoringConfiguration,
  safeMonitoringContext, sanitizeMonitoringEnvelope, sanitizeMonitoringEvent, type MonitoringContext, type MonitoringReporter } from '../shared/observability.js';

const dsn = `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/456`;
const config = monitoringConfiguration('true', dsn, 'production', '884143d')!;
const requestId = '12345678-1234-4123-8123-123456789abc';
const cleanups: MonitoringReporter[] = [];
afterEach(async () => {
  for (const reporter of cleanups.splice(0)) await reporter.close();
  getGlobalScope().setUser(null); getGlobalScope().setExtra('token', undefined); getGlobalScope().setContext('request', null);
  getGlobalScope().clearBreadcrumbs();
  getGlobalScope().clearAttachments();
});

describe('opt-in monitoring configuration', () => {
  it('does not construct an SDK transport when disabled or invalid', () => {
    let transports = 0;
    for (const value of [undefined, { ...config, enabled: false }, { ...config, dsn: 'https://private.invalid/secret' }]) {
      const reporter = createServerMonitoring(value as typeof config, { transport: () => { transports++; throw new Error('should not run'); } });
      reporter.report({ stage: 'server_api', code: 'UPSTREAM_UNAVAILABLE' });
      expect(reporter.enabled).toBe(false);
    }
    expect(transports).toBe(0);
    expect(monitoringConfiguration(undefined, dsn)).toBeUndefined();
    expect(monitoringConfiguration('false', dsn)).toBeUndefined();
    expect(monitoringConfiguration('TRUE', dsn)).toBeUndefined();
  });
  it('rejects unexpected collectors, embedded secrets and unsafe deployment labels', () => {
    for (const invalid of [dsn.replace('https:', 'http:'), dsn.replace('@', ':secret@'), `${dsn}?token=secret`, `${dsn}#secret`,
      dsn.replace('o123.ingest.us.sentry.io', 'o123.ingest.us.sentry.io.evil.invalid'), dsn.replace('o123.ingest.us.sentry.io', '127.0.0.1'),
      dsn.replace('/456', '/folder/456'), dsn.replace('/456', '/0'), dsn.replace('a'.repeat(32), 'not-a-key')]) {
      expect(monitoringConfiguration('true', invalid)).toBeUndefined();
    }
    expect(monitoringConfiguration('true', dsn, 'alice@example.invalid')).toBeUndefined();
    expect(monitoringConfiguration('true', dsn, 'production', 'token=private')).toBeUndefined();
    expect(publicMonitoringConfiguration({ ...config, token: 'private' })).toEqual(config);
    expect(publicMonitoringConfiguration({ get enabled() { throw new Error('private'); } })).toBeUndefined();
  });
});

describe('safe error context', () => {
  it('allows only fixed routes, known codes, UUID request IDs and reviewed route IDs', () => {
    expect(safeMonitoringContext({ stage: 'server_api', route: '/api/quotes', code: 'UPSTREAM_UNAVAILABLE', status: 503,
      requestId, routeId: 'solana-usdc-hypercore', amount: '123.45', token: 'private', address: '0xprivate', message: 'private' }))
      .toEqual({ stage: 'server_api', route: '/api/quotes', code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId, routeId: 'solana-usdc-hypercore' });
    expect(safeMonitoringContext({ stage: 'server_api', route: '/orders/private', code: 'TOKEN_PRIVATE', status: 200,
      requestId: 'private', routeId: 'private' })).toEqual({ stage: 'server_api', code: 'UNEXPECTED_ERROR' });
    expect(safeMonitoringContext({ stage: 'private' })).toBeUndefined();
    expect(safeMonitoringContext({ get stage() { throw new Error('private'); } })).toBeUndefined();
  });
  it('never puts order IDs, addresses or URL queries into API route labels', () => {
    expect(apiRouteTemplate('/orders/private-order?token=secret')).toBe('/api/orders/:id');
    expect(apiRouteTemplate('/account/0xprivate?amount=100')).toBe('/api/account/:address');
    expect(apiRouteTemplate('/orders/private/transaction')).toBe('/api/orders/:id/transaction');
    expect(apiRouteTemplate('/orders/private/stage')).toBe('/api/orders/:id/stage');
    expect(apiRouteTemplate('/ready')).toBe('/api/ready');
    expect(apiRouteTemplate('https://private.invalid/api')).toBe('/api/unknown');
  });
  it('rebuilds the final event and rejects non-Dock or unknown events', () => {
    const event = monitoringEvent({ stage: 'client_api', route: '/api/quotes', code: 'HTTP_ERROR' }, 'javascript', config)!;
    const contaminated = { ...event, request: { url: 'https://private.invalid/?token=secret' }, user: { email: 'private' },
      breadcrumbs: [{ message: 'private' }], extra: { amount: '123.45' }, contexts: { ...event.contexts, trace: { data: 'private' } },
      exception: { values: [{ value: 'private', stacktrace: 'private' }] }, server_name: 'private-host' };
    expect(sanitizeMonitoringEvent(contaminated, 'javascript', config)).toEqual(event);
    expect(sanitizeMonitoringEvent({ ...contaminated, message: 'private' }, 'javascript', config)).toBeNull();
    expect(sanitizeMonitoringEvent({ message: 'not-an-app-event' }, 'javascript', config)).toBeNull();
  });
  it('deduplicates bursts and caps unique errors without storing unbounded user identifiers', () => {
    let now = 0;
    const accept = monitoringBudget(() => now);
    const event = (status: number) => monitoringEvent({ stage: 'server_api', code: 'HTTP_ERROR', status }, 'node')!;
    expect(accept(event(500))).toBe(true);
    expect(accept(event(500))).toBe(false);
    for (let status = 501; status < 520; status++) expect(accept(event(status))).toBe(true);
    expect(accept(event(520))).toBe(false);
    now = 60_000;
    expect(accept(event(520))).toBe(true);
  });
  it('drops attachment/log/session/trace payloads and rebuilds envelope headers', () => {
    const event = monitoringEvent({ stage: 'server_api', code: 'HTTP_ERROR' }, 'node', config)!;
    const clean = sanitizeMonitoringEnvelope([{ trace: { user: 'SECRET' }, token: 'SECRET' }, [
      [{ type: 'attachment', filename: 'SECRET' }, 'SECRET'], [{ type: 'event' }, event], [{ type: 'log' }, { message: 'SECRET' }],
    ]], 'node', config);
    expect(clean).toEqual([{}, [[{ type: 'event' }, event]]]);
    expect(sanitizeMonitoringEnvelope([{}, [[{ type: 'session' }, { data: 'SECRET' }]]], 'node', config)).toBeUndefined();
    expect(sanitizeMonitoringEnvelope([{}, [[{ type: 'event' }, { message: 'SDK internal SECRET' }]]], 'node', config)).toBeUndefined();
  });
});

describe('actual Sentry Node SDK transport', () => {
  it('sends only the allowed event even when the SDK global scope is contaminated', async () => {
    const envelopes: unknown[] = [];
    getGlobalScope().setUser({ email: 'private@example.invalid', ip_address: '192.0.2.1' });
    getGlobalScope().setExtra('token', 'DO_NOT_SEND_TOKEN');
    getGlobalScope().setContext('request', { url: 'https://private.invalid/?secret=yes' });
    getGlobalScope().addBreadcrumb({ message: 'DO_NOT_SEND_CONSOLE' });
    getGlobalScope().addAttachment({ filename: 'DO_NOT_SEND_ATTACHMENT', data: 'DO_NOT_SEND_RAW' });
    const reporter = createServerMonitoring(config, { transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }) });
    cleanups.push(reporter);
    reporter.report({ stage: 'server_api', route: '/api/quotes', code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId,
      routeId: 'ethereum-usdt-hypercore', token: 'DO_NOT_SEND_BODY', amount: '123.45' } as MonitoringContext);
    await reporter.flush();
    expect(envelopes).toHaveLength(1);
    const serialized = JSON.stringify(envelopes);
    for (const forbidden of ['DO_NOT_SEND', 'private@example', '192.0.2.1', 'private.invalid', '123.45', 'server_name', 'breadcrumbs']) expect(serialized).not.toContain(forbidden);
    const event = (envelopes[0] as [unknown, [[unknown, { contexts: { dock: unknown }; request?: unknown; user?: unknown }]]])[1][0][1];
    expect(event.contexts).toEqual({ dock: { stage: 'server_api', route: '/api/quotes', code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId, routeId: 'ethereum-usdt-hypercore' } });
    expect(event.request).toBeUndefined(); expect(event.user).toBeUndefined();
  });
  it('keeps report non-throwing when initialization or transport fails and stops after close', async () => {
    const broken = createServerMonitoring(config, { transport: () => { throw new Error('transport-init'); } });
    expect(broken.enabled).toBe(false);
    expect(() => broken.report({ stage: 'server_api' })).not.toThrow();
    let sent = 0;
    const reporter = createServerMonitoring(config, { transport: () => ({ send: async () => { sent++; throw new Error('private failure'); }, flush: async () => false }) });
    cleanups.push(reporter);
    expect(() => reporter.report({ stage: 'server_api', code: 'UPSTREAM_UNAVAILABLE' })).not.toThrow();
    await expect(reporter.flush()).resolves.toBe(false);
    await reporter.close();
    reporter.report({ stage: 'server_api', code: 'HTTP_ERROR' });
    expect(reporter.enabled).toBe(false); expect(sent).toBe(1);
  });
});
