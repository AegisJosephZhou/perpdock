import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type HttpOptions } from '../server/app.js';
import { OrderService } from '../server/order-service.js';
import { Store } from '../server/store.js';
import type { ProviderAdapter, QuoteRequest } from '../shared/types.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import { monitoringConfiguration } from '../shared/observability.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const route = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'arbitrum-usdc-hypercore')!.route;
const input: QuoteRequest = { routeId: route.id, amount: '100', sourceAddress: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}` };
async function setup(options: Partial<HttpOptions> = {}) {
  const store = new Store(':memory:');
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [route]),
    getQuote: vi.fn(async request => ({ ...request, amountBaseUnits: '100000000', expectedReceive: '99', minReceive: '98',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), provider: 'TEST_FIXTURE_ONLY', fees: [], warnings: [], providerData: {},
      transaction: { kind: 'evm' as const, chainId: 42161, to: `0x${'3'.repeat(40)}`, value: '0', data: '0x1234' } })),
    verifySourceTransaction: vi.fn(async () => ({ valid: false, pending: true })),
    trackOrder: vi.fn(async () => ({ status: 'bridging' as const, statusMessage: 'waiting' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() })),
  };
  const service = new OrderService(store, provider, { tokenSecret: 'synthetic-observability-test-secret'.repeat(2) });
  cleanup.push(async () => { await service.stop(); store.close(); });
  const app = createApp(service, { allowedOrigins: ['https://dock.example.com'], logging: false, ...options });
  const server: Server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service, store, provider };
}
const json = (body: unknown, token?: string): RequestInit => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe('observability HTTP wiring', () => {
  it('exposes only the validated public Sentry configuration and its exact CSP origin', async () => {
    const monitoring = monitoringConfiguration('true', `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/456`, 'production', '884143d')!;
    const env = await setup({ monitoring });
    const response = await fetch(`${env.base}/api/config`);
    expect((await response.json()).monitoring).toEqual(monitoring);
    expect(response.headers.get('content-security-policy')).toContain('https://o123.ingest.us.sentry.io');
    expect(response.headers.get('content-security-policy')).not.toContain(monitoring.dsn);
    expect(response.headers.get('content-security-policy')).not.toMatch(/posthog|unsafe-eval/);
  });
  it('reports API failures with a template and request ID while excluding original error and account', async () => {
    const report = vi.fn(); const env = await setup({ monitoringReporter: { enabled: true, report, flush: async () => true, close: async () => {} } });
    env.provider.getAccount = async () => { throw new Error('PRIVATE_UPSTREAM_BODY /private/provider?key=SECRET'); };
    const response = await fetch(`${env.base}/api/account/${input.recipient}?private=SECRET`);
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(report).toHaveBeenCalledWith({ stage: 'server_api', route: '/api/account/:address', code: 'UPSTREAM_UNAVAILABLE', status: 502, requestId: body.error.requestId });
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/SECRET|PRIVATE|0x2222/);
  });
  it('monitoring exceptions do not alter API status or error response', async () => {
    const env = await setup({ monitoringReporter: { enabled: true, report: () => { throw new Error('collector down'); }, flush: async () => false, close: async () => {} } });
    const response = await fetch(`${env.base}/api/nonexistent`);
    expect(response.status).toBe(404); expect((await response.json()).error.code).toBe('NOT_FOUND');
  });
  it('accepts authenticated client observations but cannot change funding status or hashes', async () => {
    const env = await setup(); const quote = await env.service.quote(input); const created = env.service.create(quote.id, 'synthetic-key-observability');
    const endpoint = `${env.base}/api/orders/${created.order.id}/stage`;
    const stage = { stage: 'signing', eventId: randomUUID(), observedAt: new Date().toISOString() };
    expect((await fetch(endpoint, json(stage))).status).toBe(401);
    expect((await fetch(endpoint, json(stage, created.accessToken))).status).toBe(200);
    expect((await fetch(endpoint, json(stage, created.accessToken))).status).toBe(200);
    expect((await fetch(endpoint, json({ ...stage, stage: 'completed', sourceTxHash: 'fake' }, created.accessToken))).status).toBe(400);
    const order = env.service.authorize(created.order.id, created.accessToken);
    expect(order.status).toBe('awaiting_signature'); expect(order.sourceTxHash).toBeUndefined(); expect(order.destinationTxHash).toBeUndefined();
    expect(order.events).toEqual(created.order.events);
  });
  it('separates public funnel rate limits from the funding API and contains collector failure', async () => {
    const collector = vi.fn(() => { throw new Error('unavailable'); });
    const env = await setup({ rateLimitMax: 1, funnel: { client: collector } });
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${env.base}/api/funnel/events`, json({ event: 'landing' }));
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ accepted: false });
    }
    expect((await fetch(`${env.base}/api/health`)).status).toBe(200);
    expect((await fetch(`${env.base}/api/health`)).status).toBe(429);
  });
  it('allows malformed optional analytics without rejecting a legitimate quote', async () => {
    const env = await setup();
    const response = await fetch(`${env.base}/api/quotes`, json({ ...input, funnel: { arbitrary: 'ignored' } }));
    expect(response.status).toBe(201); expect((await response.json()).id).toBeTypeOf('string');
  });
  it('readiness returns 503 on DB failure without exposing diagnostics or touching providers', async () => {
    const env = await setup();
    expect((await fetch(`${env.base}/api/ready`)).status).toBe(200);
    vi.spyOn(env.store, 'ready').mockReturnValue(false);
    const response = await fetch(`${env.base}/api/ready`);
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ status: 'unavailable' });
    expect(env.provider.getRoutes).not.toHaveBeenCalled(); expect(env.provider.getAccount).not.toHaveBeenCalled();
  });
});
