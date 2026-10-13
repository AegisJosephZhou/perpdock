/** Read-only toward mainnet; creates an UNSIGNED application order. Use an isolated test backend. Never signs or broadcasts. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AppConfig, Quote, Order, Account} from '../shared/types.js';

const base = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:8787';
const routeId = process.env.SMOKE_ROUTE_ID ?? 'tron-usdt-hypercore';
const amount = process.env.SMOKE_AMOUNT ?? '100';
const recipient = process.env.SMOKE_HL_ADDRESS ?? '0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e';
const checks: string[] = [];
async function request<T>(path: string, options: RequestInit = {}): Promise<{status:number; body:T}> {
  const response = await fetch(new URL(path, base), {...options, signal:AbortSignal.timeout(45_000), headers:{'Content-Type':'application/json', ...options.headers}});
  return {status:response.status, body:await response.json() as T};
}
const config = await request<AppConfig>('/api/config');
assert.equal(config.status, 200);
assert.equal(config.body.network, 'mainnet');
assert.equal(config.body.paused, false);
const route = config.body.routes.find(r => r.id === routeId && r.available);
assert.ok(route, 'Selected route must be live. A closed route is a failed live test.');
const sourceAddress = route.walletType === 'tron'
  ? process.env.SMOKE_TRON_ADDRESS ?? 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7'
  : process.env.SMOKE_EVM_ADDRESS ?? recipient;
checks.push('real Relay chain configuration');

const account = await request<Account>(`/api/account/${recipient}`);
assert.equal(account.status, 200);
assert.equal(account.body.address.toLowerCase(), recipient.toLowerCase());
assert.match(account.body.perpsUsdc, /^-?\d+(\.\d+)?$/);
checks.push('real Hyperliquid account read');

const quoted = await request<Quote>('/api/quotes', {method:'POST', body:JSON.stringify({routeId:route.id, amount, sourceAddress, recipient})});
assert.equal(quoted.status, 201, 'Real quote request failed.');
assert.equal(quoted.body.transaction.kind, route.walletType);
assert.equal(quoted.body.provider, 'Relay');
assert.ok(Date.parse(quoted.body.expiresAt) > Date.now());
assert.equal('providerData' in quoted.body, false);
checks.push('real executable quote with validated source-chain calldata and recipient');

const key = randomUUID();
const created = await request<{order:Order; accessToken:string}>('/api/orders', {method:'POST', headers:{'Idempotency-Key':key}, body:JSON.stringify({quoteId:quoted.body.id})});
assert.equal(created.status, 201, 'Unsigned order creation failed.');
assert.equal(created.body.order.status, 'awaiting_signature');
assert.equal(created.body.order.sourceTxHash, undefined);
const repeat = await request<typeof created.body>('/api/orders', {method:'POST', headers:{'Idempotency-Key':key}, body:JSON.stringify({quoteId:quoted.body.id})});
assert.equal(repeat.body.order.id, created.body.order.id);
assert.ok(repeat.body.accessToken === created.body.accessToken, 'Idempotent retry did not recover the same order credential.');
checks.push('durable unsigned order and idempotent creation');

const denied = await request(`/api/orders/${created.body.order.id}`);
assert.equal(denied.status, 401);
const loaded = await request<Order>(`/api/orders/${created.body.order.id}`, {headers:{Authorization:`Bearer ${created.body.accessToken}`}});
assert.equal(loaded.status, 200);
assert.equal(loaded.body.quote.recipient.toLowerCase(), recipient.toLowerCase());
checks.push('order access isolation and recovery');

console.log(JSON.stringify({observedAt:new Date().toISOString(), status:'passed', checks,
  routeId:route.id, quoteSnapshot:{amount:quoted.body.amount, expectedReceive:quoted.body.expectedReceive, minReceive:quoted.body.minReceive, fees:quoted.body.fees, expiresAt:quoted.body.expiresAt},
  orderId:created.body.order.id, transactionBroadcast:false,
  limitation:'Read-only mainnet API integration; no real funds moved and no end-to-end funds test claimed.'}, null, 2));
