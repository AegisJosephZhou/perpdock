import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getOrderId as officialOrderId } from '@relay-protocol/settlement-sdk';
import { getOrderId, type RelayOrder } from '../server/providers/order-hash.js';
import { trackOrder, validateRelayQuote } from '../server/providers/relay.js';
import * as tron from '../server/chain/tron.js';
import type { TrackedOrder } from '../shared/types.js';
import { fetchJson } from '../server/chain/http.js';
import { findPerpsCredit, type Ledger } from '../server/chain/hyperliquid.js';

const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const raw = () => fixture('relay-tron-quote.json');
const canonical = fixture('relay-chains.json').chains;
const now = 1791831787228;
const input = { routeId: 'tron-usdt-hypercore', amount: '100', sourceAddress: raw().details.sender, recipient: raw().details.recipient };
const vms = { tron: 'tron-vm', hyperliquid: 'hyperliquid-vm', base: 'ethereum-vm' } as const;
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('independent protocol security review', () => {
  it('differentially matches official SDK for boundary amounts, deadlines, arrays, and address lengths', () => {
    const changes: ((order: RelayOrder) => void)[] = [
      o => { o.inputs[0]!.payment.amount = ((1n << 256n) - 1n).toString(); },
      o => { o.output.deadline = 0xffffffff; o.inputs[0]!.refunds[0]!.deadline = 0; },
      o => { o.inputs[0]!.refunds.reverse(); },
      o => { o.inputs[0]!.refunds = []; },
      o => { o.output.payments[0]!.currency = '0x00'; },
      o => { o.output.payments[0]!.recipient = '0x' + 'ab'.repeat(20); },
      o => { o.inputs[0]!.refunds[0]!.extraData = '0x001122'; },
    ];
    for (const change of changes) {
      const order = raw().protocol.v2.orderData as RelayOrder; change(order);
      expect(getOrderId(order, vms)).toBe(officialOrderId(order as Parameters<typeof officialOrderId>[0], vms));
    }
  });
  it('rejects unsupported hash encodings and execution side effects', () => {
    for (const change of [
      (o: RelayOrder) => { o.output.payments[0]!.currency = '0x'; },
      (o: RelayOrder) => { o.output.payments[0]!.currency = '0x' + '00'.repeat(21); },
      (o: RelayOrder) => { o.inputs[0]!.payment.currency = input.sourceAddress.slice(0, -1) + '8'; },
      (o: RelayOrder) => { o.output.calls = ['0x']; },
      (o: RelayOrder) => { o.fees = [{}]; },
      (o: RelayOrder) => { o.version = 'v2'; },
    ]) {
      const order = raw().protocol.v2.orderData as RelayOrder; change(order);
      expect(() => getOrderId(order, vms)).toThrow();
    }
  });
  it('rejects refund tampering, wrong source owner, TRC10 values, and extra steps before any signature', async () => {
    const changes = [
      (q: any) => { q.protocol.v2.orderData.inputs[0].refunds[0].recipient = 'TXtEs6t2oUWQsNos7m68gbHdE9Q5n6x2oN'; },
      (q: any) => { q.steps[1].items[0].data.parameter.owner_address = '41' + '11'.repeat(20); },
      (q: any) => { q.steps[1].items[0].data.parameter.call_token_value = 1; },
      (q: any) => { q.steps[1].items[0].data.parameter.token_id = 1; },
      (q: any) => { q.steps.push(structuredClone(q.steps[1])); },
    ];
    for (const change of changes) {
      const quote = raw(); change(quote);
      await expect(validateRelayQuote(quote, input, canonical, now)).rejects.toThrow();
    }
  });
  it('requires USDC in the default Perps venue, not a same-hash spot or HIP-3 credit', () => {
    const historical = fixture<Ledger>('hl-fill-ledger.json');
    const recipient = String(historical[0]!.delta.destination);
    for (const delta of [
      { ...historical[0]!.delta, destinationDex: 'spot' },
      { ...historical[0]!.delta, destinationDex: 'xyz' },
      { ...historical[0]!.delta, token: 'HYPE' },
      { ...historical[0]!.delta, destination: '0x' + '11'.repeat(20) },
      { ...historical[0]!.delta, amount: '0' },
    ]) {
      expect(findPerpsCredit([{ ...historical[0]!, delta }], recipient, [historical[0]!.hash], '500', 0)).toBeUndefined();
    }
  });
  it.each(['later', 'missing'] as const)('P2-1 recovers a proven historical fill with %s Relay updatedAt', async (mode) => {
    const historical = fixture<Ledger>('hl-fill-ledger.json');
    const status = fixture('relay-history-status.json');
    const recipient = String(historical[0]!.delta.destination);
    const draft = await validateRelayQuote(raw(), input, canonical, now);
    const sourceHash = 'a'.repeat(64);
    const quotedAt = historical[0]!.time - 60_000;
    const order: TrackedOrder = {
      id: 'security-review-only', createdAt: new Date(quotedAt).toISOString(), updatedAt: new Date(quotedAt).toISOString(),
      quote: { ...draft, id: 'security-review-quote', recipient, minReceive: '500' }, status: 'bridging', statusMessage: '', events: [],
      sourceTxHash: sourceHash, providerData: { ...draft.providerData, quotedAt },
    };
    vi.spyOn(tron, 'verifyTronSource').mockResolvedValue({ valid: true, pending: false });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/intents/status/')) return new Response(JSON.stringify({ ...status, inTxHashes: [sourceHash], updatedAt: mode === 'later' ? historical[0]!.time + 600_000 : undefined }));
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(historical.filter(entry => entry.time >= body.startTime && entry.time <= body.endTime)));
    }));
    expect((await trackOrder(order)).status).toBe('completed');
  });
  it('handles status errors, invalid JSON, oversized streams, and redirects without returning raw upstream content', async () => {
    for (const [status, code] of [[401, 'PROVIDER_AUTH_REQUIRED'], [403, 'PROVIDER_AUTH_REQUIRED'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'UPSTREAM_HTTP_ERROR']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('API_KEY=secret', { status })));
      await expect(fetchJson('https://api.relay.link/test')).rejects.toMatchObject({ code });
      await expect(fetchJson('https://api.relay.link/test')).rejects.not.toThrow('API_KEY');
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{broken', { status: 200 })));
    await expect(fetchJson('https://api.relay.link/test')).rejects.toMatchObject({ code: 'INVALID_UPSTREAM_RESPONSE' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(4_000_001), { status: 200 })));
    await expect(fetchJson('https://api.relay.link/test')).rejects.toMatchObject({ code: 'UPSTREAM_RESPONSE_TOO_LARGE' });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => { expect(init?.redirect).toBe('error'); throw new Error('redirect disallowed'); });
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchJson('https://api.relay.link/test')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
  it('aborts a hanging upstream at 15 seconds without implying a failed transfer', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const promise = expect(fetchJson('https://api.relay.link/test')).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 });
    await vi.advanceTimersByTimeAsync(15_000);
    await promise;
  });
});
