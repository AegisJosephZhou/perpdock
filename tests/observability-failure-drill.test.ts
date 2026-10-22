import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp } from '../server/app.js';
import { fetchJson } from '../server/chain/http.js';
import { FunnelRecorder } from '../server/funnel.js';
import { createServerMonitoring, monitoringConfiguration } from '../server/observability.js';
import { OrderService } from '../server/order-service.js';
import { Store } from '../server/store.js';
import { ordersReport } from '../scripts/orders-report.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import type { SafeMonitoringEvent } from '../shared/observability.js';
import type { Order, ProviderAdapter, ProviderQuote, Quote, QuoteRequest, TrackingUpdate } from '../shared/types.js';

// Real loopback HTTP and real Sentry SDK; no SaaS, RPC, wallet or production database.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Isolated failure-drill cleanup failed.');
});

async function listen(server: Server, port = 0): Promise<string> {
  cleanups.push(() => close(server));
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolveListen(); };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections();
  });
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 65_536) throw new Error('Synthetic loopback body exceeds fixture limit.');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function read<T>(path: string, sql: string, ...parameters: string[]): T[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA query_only=ON'); return db.prepare(sql).all(...parameters) as T[]; }
  finally { db.close(); }
}
const json = (value: unknown, token?: string): RequestInit => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(value), signal: AbortSignal.timeout(3000) });
type Envelope = [unknown, Array<[{ type: string }, SafeMonitoringEvent]>];

describe('isolated real-connection failure drill', () => {
  it('matches a quote error to Sentry and persists query outage/recovery without manufacturing failed or completed funds', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dock-failure-drill-'));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const fundingPath = join(directory, 'funding.sqlite'), funnelPath = join(directory, 'funnel.sqlite');
    const route = REVIEWED_EVM_SOURCES.find(item => item.route.id === 'arbitrum-usdc-hypercore')!.route;
    const input: QuoteRequest = { routeId: route.id, amount: '100', sourceAddress: `0x${'1'.repeat(40)}`, recipient: `0x${'2'.repeat(40)}` };
    const syntheticHash = `0x${'a'.repeat(64)}`, syntheticSecret = 'synthetic-failure-drill-secret-01234567890123456789';
    const quoteFixture = (request: QuoteRequest): ProviderQuote => ({ ...request, amountBaseUnits: '100000000',
      expectedReceive: '99', minReceive: '98', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      provider: 'SYNTHETIC_LOOPBACK_ONLY', fees: [], warnings: [], providerData: {},
      transaction: { kind: 'evm', chainId: 42161, to: `0x${'3'.repeat(40)}`, data: '0x1234', value: '0' } });
    const trackingFixture: TrackingUpdate = { status: 'bridging', statusMessage: 'SYNTHETIC ONLY: still awaiting attributable credit.' };
    let upstream: Server, upstreamUrl = '', upstreamPort = 0, successfulQuoteReads = 0, successfulTrackingReads = 0;
    const startUpstream = async () => {
      upstream = createServer((req, res) => {
        void (async () => {
          res.setHeader('Content-Type', 'application/json');
          if (req.url === '/quote' && req.method === 'POST') {
            const request = await body(req) as QuoteRequest; successfulQuoteReads++;
            res.end(JSON.stringify(quoteFixture(request)));
          } else if (req.url === '/tracking' && req.method === 'GET') {
            successfulTrackingReads++; res.end(JSON.stringify(trackingFixture));
          } else { res.statusCode = 404; res.end('{}'); }
        })().catch(() => { res.statusCode = 400; res.end('{}'); });
      });
      upstreamUrl = await listen(upstream, upstreamPort);
      upstreamPort = (upstream.address() as AddressInfo).port;
    };
    await startUpstream();

    const envelopes: Envelope[] = [];
    const receiver = createServer((req, res) => {
      void (async () => {
        if (req.method !== 'POST' || req.url !== '/envelope') { res.statusCode = 404; res.end(); return; }
        envelopes.push(await body(req) as Envelope);
        res.setHeader('Content-Type', 'application/json'); res.end('{"accepted":true}');
      })().catch(() => { res.statusCode = 400; res.end(); });
    });
    const receiverUrl = await listen(receiver);
    const pending = new Set<Promise<{ statusCode: number }>>();
    // This syntactically valid dummy DSN never controls an HTTP destination.
    const configuration = monitoringConfiguration('true', `https://${'b'.repeat(32)}@o123.ingest.us.sentry.io/456`, 'development', '1a37ddf')!;
    const monitoring = createServerMonitoring(configuration, { transport: () => ({
      send(envelope) {
        const task = (async () => {
          const response = await fetch(`${receiverUrl}/envelope`, { ...json(envelope), redirect: 'error' });
          await response.arrayBuffer(); return { statusCode: response.status };
        })().finally(() => pending.delete(task));
        pending.add(task); return task;
      },
      async flush() { return (await Promise.allSettled([...pending])).every(result => result.status === 'fulfilled'); },
    }) });
    cleanups.push(() => monitoring.close());
    expect(monitoring.enabled).toBe(true);
    const funnel = new FunnelRecorder(funnelPath, { enabled: true });
    cleanups.push(() => funnel.close());
    const store = new Store(fundingPath); cleanups.push(() => store.close());
    const provider: ProviderAdapter = {
      getRoutes: async () => [route],
      getQuote: async request => await fetchJson(`${upstreamUrl}/quote`, json(request), 1000) as ProviderQuote,
      trackOrder: async () => await fetchJson(`${upstreamUrl}/tracking`, {}, 1000) as TrackingUpdate,
      // This is an explicitly synthetic verification fixture, never a chain query or a real payment.
      verifySourceTransaction: async () => ({ valid: true, pending: false }),
      getAccount: async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() }),
    };
    const service = new OrderService(store, provider, { tokenSecret: syntheticSecret, funnel,
      onTrackingUnavailable: routeId => monitoring.report({ stage: 'order_tracking', code: 'UPSTREAM_UNAVAILABLE', routeId }) });
    cleanups.push(() => service.stop());
    const app = createApp(service, { allowedOrigins: [], logging: false, monitoring: configuration, monitoringReporter: monitoring, funnel });
    const api = await listen(createServer(app));
    const events = () => envelopes.flatMap(envelope => envelope[1].filter(item => item[0].type === 'event').map(item => item[1]));
    const counts = () => read<{ quotes: number; orders: number; events: number }>(fundingPath,
      'SELECT (SELECT COUNT(*) FROM quotes) AS quotes, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM order_events) AS events')[0];

    // Prove the very same adapter and URL were healthy without persisting a funding quote.
    expect((await provider.getQuote(input)).provider).toBe('SYNTHETIC_LOOPBACK_ONLY');
    expect(successfulQuoteReads).toBe(1); expect(counts()).toEqual({ quotes: 0, orders: 0, events: 0 });
    await close(upstream!); expect(upstream!.listening).toBe(false);
    const failedContext = { sessionId: randomUUID(), attemptId: randomUUID(), lang: 'en' as const };
    const failedResponse = await fetch(`${api}/api/quotes`, json({ ...input, funnel: failedContext }));
    const failedBody = await failedResponse.json() as { error: { code: string; requestId: string } };
    expect(failedResponse.status).toBe(503); expect(failedBody.error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(failedResponse.headers.get('x-request-id')).toBe(failedBody.error.requestId);
    expect(await monitoring.flush(2000)).toBe(true);
    const quoteEvent = events().find(event => event.contexts.dock.stage === 'server_api')!;
    expect(quoteEvent.contexts.dock).toEqual({ stage: 'server_api', route: '/api/quotes', code: 'UPSTREAM_UNAVAILABLE', status: 503, requestId: failedBody.error.requestId });
    const failedFunding = counts(); expect(failedFunding).toEqual({ quotes: 0, orders: 0, events: 0 });
    const attempt = read<{ outcome: string; quote_id: string | null }>(funnelPath,
      'SELECT outcome,quote_id FROM funnel_attempts WHERE attempt_id=?', failedContext.attemptId);
    expect(attempt).toEqual([{ outcome: 'failed', quote_id: null }]);
    const failedStages = read<{ event: string; authority: string; delivery: string }>(funnelPath,
      'SELECT event,authority,delivery FROM funnel_events WHERE session_id=? ORDER BY event', failedContext.sessionId);
    expect(failedStages).toEqual([
      { event: 'quote_failed', authority: 'server', delivery: 'local_only' },
      { event: 'quote_requested', authority: 'server', delivery: 'local_only' },
    ]);
    expect(successfulQuoteReads).toBe(1); // The closed listener never processed the failed request.

    await startUpstream();
    const restoredResponse = await fetch(`${api}/api/quotes`, json({ ...input, funnel: { ...failedContext, attemptId: randomUUID() } }));
    expect(restoredResponse.status).toBe(201);
    const quote = await restoredResponse.json() as Quote;
    expect(successfulQuoteReads).toBe(2); expect(counts()).toEqual({ quotes: 1, orders: 0, events: 0 });
    const createResponse = await fetch(`${api}/api/orders`, { ...json({ quoteId: quote.id }),
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as { order: Order; accessToken: string };
    const transactionResponse = await fetch(`${api}/api/orders/${created.order.id}/transaction`, json({ txHash: syntheticHash }, created.accessToken));
    expect(transactionResponse.status).toBe(200);
    const submitted = await transactionResponse.json() as Order;
    expect(submitted.status).toBe('bridging'); expect(submitted.sourceTxHash).toBe(syntheticHash);
    const healthyResponse = await fetch(`${api}/api/orders/${created.order.id}/refresh`, json({}, created.accessToken));
    expect(healthyResponse.status).toBe(200);
    const healthy = await healthyResponse.json() as Order;
    expect(healthy.trackingCheck?.result).toBe('ok'); expect(successfulTrackingReads).toBe(1);
    const previousSuccess = healthy.trackingCheck!.succeededAt!;

    await close(upstream!); expect(upstream!.listening).toBe(false);
    // Make only this fixture due immediately; tick is the production background polling path.
    store.schedulePoll(created.order.id, Date.now(), store.pollFailures(created.order.id));
    const beforeFailedTick = Date.now();
    await service.tick();
    const afterFailedTick = Date.now();
    const unavailable = store.getOrder(created.order.id)!.order;
    expect(unavailable.status).toBe('bridging'); expect(unavailable.sourceTxHash).toBe(syntheticHash);
    expect(unavailable.destinationTxHash).toBeUndefined(); expect(unavailable.creditedAmount).toBeUndefined();
    expect(unavailable.evidence).toEqual(healthy.evidence);
    expect(unavailable.timings).toEqual(healthy.timings);
    expect(unavailable.trackingCheck?.result).toBe('unavailable');
    expect(Date.parse(unavailable.trackingCheck!.attemptedAt)).toBeGreaterThanOrEqual(Date.parse(previousSuccess));
    expect(unavailable.trackingCheck!.succeededAt).toBe(previousSuccess);
    expect(store.pollFailures(created.order.id)).toBe(1); expect(successfulTrackingReads).toBe(1);
    const afterFailure = read<{ payload: string; poll_failures: number; next_poll_at: number }>(fundingPath,
      'SELECT payload,poll_failures,next_poll_at FROM orders WHERE id=?', created.order.id)[0];
    expect((JSON.parse(afterFailure.payload) as Order).trackingCheck).toEqual(unavailable.trackingCheck);
    expect(afterFailure.poll_failures).toBe(1);
    expect(afterFailure.next_poll_at).toBeGreaterThanOrEqual(beforeFailedTick + 10_000);
    expect(afterFailure.next_poll_at).toBeLessThanOrEqual(afterFailedTick + 10_000);
    expect(afterFailure.next_poll_at).toBeGreaterThan(Date.parse(unavailable.trackingCheck!.attemptedAt));
    expect(await monitoring.flush(2000)).toBe(true);
    const trackingEvent = events().find(event => event.contexts.dock.stage === 'order_tracking')!;
    expect(trackingEvent.contexts.dock).toEqual({ stage: 'order_tracking', code: 'UPSTREAM_UNAVAILABLE', routeId: route.id });
    const from = created.order.createdAt.slice(0, 10), until = new Date(Date.parse(`${from}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const outageReport = ordersReport(fundingPath, { from, until });
    expect(outageReport.summary.queryUnavailableOrders).toBe(1); expect(outageReport.summary.verifiedCompletedOrders).toBe(0);

    await startUpstream();
    store.schedulePoll(created.order.id, Date.now(), store.pollFailures(created.order.id));
    await service.tick();
    const recovered = store.getOrder(created.order.id)!.order;
    expect(recovered.status).toBe('bridging'); expect(recovered.sourceTxHash).toBe(syntheticHash);
    expect(recovered.trackingCheck?.result).toBe('ok');
    expect(recovered.trackingCheck!.succeededAt).toBe(recovered.trackingCheck!.attemptedAt);
    expect(Date.parse(recovered.trackingCheck!.succeededAt!)).toBeGreaterThanOrEqual(Date.parse(unavailable.trackingCheck!.attemptedAt));
    expect(store.pollFailures(created.order.id)).toBe(0); expect(successfulTrackingReads).toBe(2);
    expect(recovered.destinationTxHash).toBeUndefined(); expect(recovered.creditedAmount).toBeUndefined();
    expect(recovered.events.some(event => event.status === 'completed')).toBe(false);
    expect(recovered.timings?.creditVerifiedObservedAt).toBeUndefined();
    const recoveryReport = ordersReport(fundingPath, { from, until });
    expect(recoveryReport.summary.queryUnavailableOrders).toBe(0); expect(recoveryReport.summary.verifiedCompletedOrders).toBe(0);
    expect(read<{ n: number }>(funnelPath, "SELECT COUNT(*) AS n FROM funnel_events WHERE event='credit_verified'")[0].n).toBe(0);
    expect(await monitoring.flush(2000)).toBe(true); expect(events()).toHaveLength(2);

    const evidence = { schemaVersion: 1, generatedAt: new Date().toISOString(),
      scope: 'Synthetic fixtures; real loopback upstream connection failures, createApp HTTP, Sentry NodeClient and local HTTP receiver; no SaaS ingestion or wallet verification.',
      quoteFailure: { httpStatus: failedResponse.status, code: failedBody.error.code, requestId: failedBody.error.requestId,
        headerMatchesBody: failedResponse.headers.get('x-request-id') === failedBody.error.requestId,
        sentryMatchesBody: quoteEvent.contexts.dock.requestId === failedBody.error.requestId,
        financialRows: failedFunding, attemptOutcome: attempt[0].outcome, hasQuoteId: attempt[0].quote_id !== null,
        persistedStages: failedStages, restoredHttpStatus: restoredResponse.status },
      trackingFailure: { status: unavailable.status, sourceReferencePreserved: unavailable.sourceTxHash === submitted.sourceTxHash,
        check: unavailable.trackingCheck, previousSuccessPreserved: unavailable.trackingCheck?.succeededAt === previousSuccess,
        persistedPollFailures: afterFailure.poll_failures,
        scheduledRetryDelayMs: afterFailure.next_poll_at - Date.parse(unavailable.trackingCheck!.attemptedAt),
        queryUnavailableOrders: outageReport.summary.queryUnavailableOrders,
        verifiedCompletedOrders: outageReport.summary.verifiedCompletedOrders, diagnostic: trackingEvent.contexts.dock },
      recovery: { status: recovered.status, sourceReferencePreserved: recovered.sourceTxHash === submitted.sourceTxHash,
        check: recovered.trackingCheck, pollFailures: store.pollFailures(created.order.id),
        queryUnavailableOrders: recoveryReport.summary.queryUnavailableOrders, verifiedCompletedOrders: recoveryReport.summary.verifiedCompletedOrders,
        hasDestinationReference: recovered.destinationTxHash !== undefined, hasCreditedAmount: recovered.creditedAmount !== undefined },
      transport: { destination: '127.0.0.1 local HTTP receiver only', sdk: 'Sentry NodeClient', receivedEnvelopes: envelopes.length },
      limitations: ['SaaS receipt and alert delivery were not tested.', 'Funnel attempt has no persisted requestId join to Sentry.',
        'Background Sentry diagnostics identify route only, not a specific order.', 'Polling was made immediately due only inside the synthetic fixture.'],
    };
    const safeArtifactText = JSON.stringify({ evidence, envelopes });
    for (const value of [input.sourceAddress, input.recipient, syntheticHash, syntheticSecret, created.accessToken, created.order.id, quote.id,
      failedContext.sessionId, failedContext.attemptId, configuration.dsn]) expect(safeArtifactText.includes(value)).toBe(false);
    expect(safeArtifactText).not.toMatch(/Authorization|Bearer |providerData|sourceTxHash|destinationTxHash/);
    const evidenceDirectory = process.env.DOCK_FAILURE_DRILL_EVIDENCE;
    if (evidenceDirectory) {
      const destination = resolve(evidenceDirectory); mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeFileSync(join(destination, 'failure-drill-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
      writeFileSync(join(destination, 'sentry-local-envelopes.json'), `${JSON.stringify(envelopes, null, 2)}\n`, { mode: 0o600 });
    }
  });
});
