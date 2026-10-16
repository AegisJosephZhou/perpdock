import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, walletConnectConfig } from '../server/app.js';
import { OrderService } from '../server/order-service.js';
import { Store } from '../server/store.js';
import type { ProviderAdapter } from '../shared/types.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';

// Synthetic identifiers and providers only: no dashboard, relay or chain requests.
const projectId = '0123456789abcdef'.repeat(2);
const tokenSecret = 'isolated-walletconnect-config-test-secret'.repeat(2);
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});

async function httpSetup(id?: string) {
  const store = new Store(':memory:');
  const provider: ProviderAdapter = {
    getRoutes: vi.fn(async () => [REVIEWED_EVM_SOURCES[0]!.route]),
    getQuote: vi.fn(async () => { throw new Error('Not used in public configuration tests'); }),
    verifySourceTransaction: vi.fn(async () => ({ valid: false })),
    trackOrder: vi.fn(async () => ({ status: 'attention' as const, statusMessage: 'Not used in public configuration tests' })),
    getAccount: vi.fn(async address => ({ address, perpsUsdc: '0', withdrawableUsdc: '0', observedAt: new Date().toISOString() })),
  };
  const service = new OrderService(store, provider, { tokenSecret, appName: 'Perpex', minAmount: '10', maxAmount: '100', paused: () => true });
  cleanup.push(async () => { await service.stop(); store.close(); });
  const app = createApp(service, { allowedOrigins: ['https://deposit.perpex.ai'], logging: false, walletConnectProjectId: id });
  const server: Server = await new Promise((resolveServer, reject) => {
    const instance = app.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolveServer(instance));
  });
  cleanup.push(() => new Promise<void>(resolveServer => { server.close(() => resolveServer()); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, service };
}

function directives(response: Response): Record<string, string[]> {
  return Object.fromEntries(response.headers.get('content-security-policy')!.split(';').map(rule => {
    const [name, ...values] = rule.trim().split(/\s+/);
    return [name, values];
  }));
}

describe('optional runtime WalletConnect public configuration', () => {
  it.each([undefined, ''])('keeps the original configuration and CSP when ID is %s', async id => {
    const env = await httpSetup(id);
    const response = await fetch(`${env.base}/api/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await env.service.config());
    expect(directives(response)['connect-src']).toEqual(["'self'", 'https://api.trongrid.io', 'https://api.tronstack.io', 'https://tron-rpc.publicnode.com']);
    expect(response.headers.get('content-security-policy')).not.toContain('walletconnect');
  });

  it('adds only the configured public ID without exposing runtime secrets or privileged RPC URLs', async () => {
    vi.stubEnv('ORDER_TOKEN_SECRET', 'PRIVATE_ORDER_TOKEN_ENV');
    vi.stubEnv('RELAY_API_KEY', 'PRIVATE_RELAY_ENV');
    vi.stubEnv('TRONGRID_API_KEY', 'PRIVATE_TRONGRID_ENV');
    vi.stubEnv('ETHEREUM_RPC_URL', 'https://private-rpc.invalid/PRIVATE_RPC_ENV');
    const env = await httpSetup(projectId);
    const response = await fetch(`${env.base}/api/config`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual({ ...await env.service.config(), walletConnect: { projectId } });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|tokenSecret|ORDER_TOKEN_SECRET|RELAY_API_KEY|TRONGRID_API_KEY|ETHEREUM_RPC_URL/);
    expect(JSON.stringify(body)).not.toContain(tokenSecret);
    expect(response.headers.get('content-security-policy')).not.toContain('private-rpc');
  });

  it('permits SDK relay/verify and reviewed public RPCs while retaining self scripts and frame isolation', async () => {
    const env = await httpSetup(projectId);
    const response = await fetch(`${env.base}/api/config`);
    const csp = directives(response);
    expect(csp['connect-src']).toEqual([
      "'self'", 'https://api.trongrid.io', 'https://api.tronstack.io', 'https://tron-rpc.publicnode.com',
      'wss://relay.walletconnect.com', 'wss://relay.walletconnect.org',
      'https://verify.walletconnect.com', 'https://verify.walletconnect.org',
      ...new Set(REVIEWED_EVM_SOURCES.map(source => new URL(source.publicRpcUrl).origin)),
    ]);
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['img-src']).toEqual(["'self'", 'data:']);
    expect(csp['frame-src']).toEqual(['https://verify.walletconnect.org']);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(response.headers.get('content-security-policy')).not.toMatch(/\*|unsafe-eval|pulse\.walletconnect|explorer\.walletconnect|rpc\.walletconnect/);
  });

  it('accepts hexadecimal IDs, but rejects malformed configuration without echoing it', () => {
    expect(walletConnectConfig(projectId.toUpperCase())).toEqual({ projectId: projectId.toUpperCase() });
    for (const value of ['missing-project-id', 'a'.repeat(31), 'a'.repeat(33), 'g'.repeat(32), ' ', `${projectId}\n`, ` ${projectId}`]) {
      expect(() => walletConnectConfig(value)).toThrow('WALLETCONNECT_PROJECT_ID');
      try { walletConnectConfig(value); } catch (error) {
        if (value.trim()) expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('fails invalid startup configuration before creating a local key or database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perpex-wc-config-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const dataDir = join(dir, 'uncreated-data');
    let output = '';
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
        cwd: resolve('.'), timeout: 10_000, encoding: 'utf8', stdio: 'pipe',
        env: { PATH: process.env.PATH, NODE_ENV: 'development', DATA_DIR: dataDir, WALLETCONNECT_PROJECT_ID: 'invalid-config-must-not-be-echoed' },
      });
      throw new Error('Invalid startup configuration was accepted');
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      expect(failure.status).toBe(1);
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    expect(output).toContain('WALLETCONNECT_PROJECT_ID');
    expect(output).not.toContain('invalid-config-must-not-be-echoed');
    expect(existsSync(dataDir)).toBe(false);
  });
});
