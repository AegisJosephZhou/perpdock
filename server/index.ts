import { resolve } from 'node:path';
import { createApp, walletConnectConfig } from './app.js';
import { Store } from './store.js';
import { OrderService } from './order-service.js';
import { loadTokenSecret } from './security.js';
import * as providers from './providers/index.js';
import type { ProviderAdapter } from '../shared/types.js';

const production = process.env.NODE_ENV === 'production';
// Fail invalid public configuration before opening the order store or creating a local key.
const walletConnect = walletConnectConfig(process.env.WALLETCONNECT_PROJECT_ID);
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const tokenSecret = loadTokenSecret(resolve(dataDir, 'order-token.key'), process.env.ORDER_TOKEN_SECRET, production);
const store = new Store(resolve(dataDir, 'funding.sqlite'));
const service = new OrderService(store, providers satisfies ProviderAdapter, {
  tokenSecret, appName: process.env.APP_NAME ?? 'Perpex',
  minAmount: process.env.MIN_AMOUNT ?? '10', maxAmount: process.env.MAX_AMOUNT ?? '1000',
  paused: () => process.env.PAUSE_NEW_ORDERS === 'true',
});
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (production && !publicOrigin) throw new Error('Production requires PUBLIC_ORIGIN.');
const origins = publicOrigin ? [new URL(publicOrigin).origin] : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:8787', 'http://127.0.0.1:8787'];
if (process.env.TRUST_PROXY_HOPS && process.env.TRUST_PROXY_HOPS !== '1') throw new Error('TRUST_PROXY_HOPS must be omitted or 1.');
const app = createApp(service, { allowedOrigins: origins, staticDir: resolve('dist/client'),
  ...(walletConnect ? { walletConnectProjectId: walletConnect.projectId } : {}),
  ...(process.env.TRUST_PROXY_HOPS === '1' ? { trustProxyHops: 1 } : {}) });
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid.');
const server = app.listen(port, process.env.HOST ?? '127.0.0.1', (error?: Error) => {
  if (error) {
    console.error(JSON.stringify({ event: 'server_listen_failed', code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }));
    store.close();
    process.exitCode = 1;
    return;
  }
  console.info(JSON.stringify({ event: 'server_started', port, production }));
  service.startPolling();
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  server.close(() => { void service.stop().then(() => { store.close(); process.exit(0); }); });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
