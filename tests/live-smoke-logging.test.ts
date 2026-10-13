import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Test-only fetch stub. Exercise failing script processes without contacting a
// provider, creating real orders, or writing any application database.
for (const scenario of ['create-failure', 'credential-mismatch'] as const) {
  it(`does not print order credentials on ${scenario}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'perpex-log-regression-'));
    const tokens = ['SECRET_ORDER_CREDENTIAL_FIRST_123', 'SECRET_ORDER_CREDENTIAL_OTHER_456'];
    try {
      const hook = join(dir, 'fetch-fixture.mjs');
      writeFileSync(hook, `
const tokens = ${JSON.stringify(tokens)};
let creates = 0;
globalThis.fetch = async (input) => {
  const path = new URL(input).pathname;
  let status = 200;
  let body;
  if (path === '/api/config') body = {
    network: 'mainnet', paused: false,
    routes: [{id: 'tron-usdt-hypercore', available: true, walletType: 'tron'}]
  };
  else if (path.startsWith('/api/account/')) body = {
    address: path.split('/').at(-1), perpsUsdc: '0'
  };
  else if (path === '/api/quotes') {
    status = 201;
    body = {id: 'test-quote', provider: 'Relay', transaction: {kind: 'tron'},
      expiresAt: new Date(Date.now() + 120000).toISOString()};
  } else if (path === '/api/orders') {
    status = ${JSON.stringify(scenario)} === 'create-failure' ? 500 : 201;
    body = {order: {id: 'test-order', status: 'awaiting_signature'},
      accessToken: tokens[Math.min(creates++, 1)]};
  } else throw new Error('Unexpected test-only request');
  return new Response(JSON.stringify(body), {status});
};
`);
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', '--import', pathToFileURL(hook).href,
        resolve('scripts/live-smoke.ts'),
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
        env: { ...process.env, SMOKE_ROUTE_ID: 'tron-usdt-hypercore', SMOKE_BASE_URL: 'https://isolated-test.invalid' } });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      const output = result.stdout + result.stderr;
      expect(output).toContain(scenario === 'create-failure'
        ? 'Unsigned order creation failed.'
        : 'Idempotent retry did not recover the same order credential.');
      for (const token of tokens) expect(output).not.toContain(token);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
}
