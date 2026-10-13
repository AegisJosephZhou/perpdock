/** Node 24 production/backup acceptance. Real read-only mainnet calls; no signing or broadcast.
 * Run `npm run build` first, then run this file with the intended Node 24 binary.
 * Only this script's temporary directory and child processes are cleaned up. */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

class AcceptanceError extends Error {}
const requireCheck = (condition, message) => { if (!condition) throw new AcceptanceError(message); };
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
const checks = [];
const { REVIEWED_EVM_SOURCES } = await import('../dist/shared/route-registry.js');
let tempRoot;
let stage = 'initialization';
let interrupted = false;
const secret = randomBytes(48).toString('base64url');
const tronSource = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const recipient = '0xf3d63166f0ca56c3c1a3508fce03ff0cf3fb691e';
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function passed(label) {
  checks.push(label);
  console.log(JSON.stringify({ status: 'check_passed', check: label }));
}
async function availablePort() {
  const socket = createServer();
  await new Promise((ready, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', ready); });
  const address = socket.address();
  await new Promise((done, reject) => socket.close(error => error ? reject(error) : done()));
  requireCheck(address && typeof address !== 'string', 'Could not allocate a loopback port.');
  return address.port;
}
function launch(args, env) {
  const child = spawn(process.execPath, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, output: '', errors: '', exited: false, code: null, started: false };
  state.exit = new Promise(resolveExit => {
    child.once('error', () => { state.exited = true; resolveExit({ code: null, signal: 'SPAWN_FAILED' }); });
    child.once('exit', (code, signal) => { state.exited = true; state.code = code; children.delete(state); resolveExit({ code, signal }); });
  });
  child.stdout.on('data', chunk => {
    state.output = (state.output + chunk.toString()).slice(-65_536);
    if (state.output.includes('"event":"server_started"')) state.started = true;
  });
  // Capture for control only; never echo process output containing credentials.
  child.stderr.on('data', chunk => { state.errors = (state.errors + chunk.toString()).slice(-65_536); });
  children.add(state);
  return state;
}
async function waitExit(state, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      state.exit,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new AcceptanceError('Child process did not exit within its deadline.')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function stopServer(state) {
  if (!state.exited) state.child.kill('SIGTERM');
  const ended = await waitExit(state, 12_000);
  requireCheck(ended.code === 0, 'Production server did not shut down cleanly.');
}
async function cleanup() {
  for (const state of [...children]) {
    try {
      if (!state.exited) state.child.kill('SIGTERM');
      await waitExit(state, 12_000);
    } catch {
      if (!state.exited) state.child.kill('SIGKILL');
      await state.exit;
    }
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  void cleanup().finally(() => process.exit(130));
});
async function startServer(dataDir) {
  requireCheck(!interrupted, 'Acceptance run interrupted.');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
    DATA_DIR: dataDir, ORDER_TOKEN_SECRET: secret, TRUST_PROXY_HOPS: '', MIN_AMOUNT: '10', MAX_AMOUNT: '1000', PAUSE_NEW_ORDERS: 'false' };
  const state = launch(['dist/server/index.js'], env);
  for (let attempt = 0; attempt < 100; attempt++) {
    requireCheck(!state.exited, 'Production server exited before becoming ready.');
    if (state.started) {
      try {
        const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && (await response.json()).status === 'ok') return Object.assign(state, { origin, env });
      } catch { /* Bounded startup retry, without a fake health response. */ }
    }
    await delay(100);
  }
  throw new AcceptanceError('Production server never became ready.');
}
async function request(server, path, options = {}) {
  const response = await fetch(new URL(path, server.origin), { ...options, signal: AbortSignal.timeout(45_000),
    headers: { 'Content-Type': 'application/json', Origin: server.origin, ...options.headers } });
  const body = await response.json();
  return { response, body };
}
function assertPrivateFieldsAbsent(body) {
  const text = JSON.stringify(body);
  requireCheck(!text.includes('providerData') && !text.includes('tokenHash') && !text.includes(secret), 'A private server field leaked into an order response.');
}
async function checkRecovery(server, original, quoteId, idempotencyKey) {
  const loaded = await request(server, `/api/orders/${original.order.id}`, { headers: { Authorization: `Bearer ${original.accessToken}` } });
  requireCheck(loaded.response.status === 200, 'Original order token did not authorize the recovered order.');
  requireCheck(loaded.body.id === original.order.id && loaded.body.quote.id === quoteId, 'Recovered order identity changed.');
  requireCheck(loaded.body.sourceTxHash === undefined && ['awaiting_signature', 'expired'].includes(loaded.body.status), 'Unsigned order unexpectedly acquired a transaction or funding state.');
  assertPrivateFieldsAbsent(loaded.body);
  const retry = await request(server, '/api/orders', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ quoteId }) });
  requireCheck(retry.response.status === 201 && retry.body.order.id === original.order.id, 'Idempotency did not recover the original order.');
  // Never use equality assertions that could print token values on failure.
  requireCheck(retry.body.accessToken === original.accessToken, 'Idempotent retry did not recover the same access token.');
}

try {
  requireCheck(process.versions.node.split('.')[0] === '24', 'Run this acceptance script with the target Node 24 runtime.');
  await stat(join(project, 'dist/server/index.js'));
  tempRoot = await mkdtemp(join(tmpdir(), 'hl-production-qa-'));
  stage = 'production startup and static assets';
  const dataDir = join(tempRoot, 'original');
  let server = await startServer(dataDir);
  const index = await fetch(server.origin, { signal: AbortSignal.timeout(5000) });
  requireCheck(index.status === 200 && /text\/html/.test(index.headers.get('content-type') ?? ''), 'Production index did not return HTML.');
  const html = await index.text();
  const builtHtml = await readFile(join(project, 'dist/client/index.html'), 'utf8');
  requireCheck(html === builtHtml, 'Production did not serve the current built index.');
  const scriptPath = /<script\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
  requireCheck(scriptPath?.startsWith('/assets/'), 'Built application JavaScript asset was not found.');
  const assetUrl = new URL(scriptPath, server.origin);
  requireCheck(assetUrl.origin === server.origin, 'Unexpected external application script.');
  const asset = await fetch(assetUrl, { signal: AbortSignal.timeout(5000) });
  requireCheck(asset.status === 200 && /javascript/.test(asset.headers.get('content-type') ?? '') && (await asset.text()).length > 1000, 'Built application JavaScript was not served.');
  const connect = index.headers.get('content-security-policy')?.split(';').find(value => value.startsWith('connect-src'));
  requireCheck(connect === "connect-src 'self' https://api.trongrid.io https://api.tronstack.io https://tron-rpc.publicnode.com", 'Production CSP does not use the exact reviewed RPC allowlist.');
  passed('Node 24 production health, built HTML/JS and exact CSP');

  stage = 'real read-only mainnet routes, account and quotes';
  const config = await request(server, '/api/config');
  requireCheck(config.response.status === 200 && config.body.network === 'mainnet' && config.body.paused === false, 'Production mainnet configuration unavailable.');
  requireCheck(config.body.routes?.[0]?.id === 'ethereum-usdt-hypercore', 'Ethereum is not the default route.');
  const account = await request(server, `/api/account/${recipient}`);
  requireCheck(account.response.status === 200 && account.body.address.toLowerCase() === recipient.toLowerCase(), 'Real Hyperliquid account lookup failed.');
  const cases = [
    ...REVIEWED_EVM_SOURCES.map(({ route }) => ({ routeId: route.id, chainId: route.sourceChainId, kind: 'evm', sourceAddress: recipient, amount: '10' })),
    { routeId: 'tron-usdt-hypercore', kind: 'tron', sourceAddress: tronSource, amount: '100' },
  ];
  const orders = [];
  const quoteSnapshots = [];
  for (const test of cases) {
    stage = `real read-only quote and unsigned order: ${test.routeId}`;
    const route = config.body.routes?.find(candidate => candidate.id === test.routeId && candidate.available);
    requireCheck(route, `Actual ${test.routeId} route is unavailable; this is not a successful live run.`);
    const quoted = await request(server, '/api/quotes', { method: 'POST', body: JSON.stringify({ routeId: route.id, amount: test.amount, sourceAddress: test.sourceAddress, recipient }) });
    requireCheck(quoted.response.status === 201 && quoted.body.provider === 'Relay' && quoted.body.transaction?.kind === test.kind, `Real Relay quote failed for ${test.routeId}.`);
    requireCheck(Date.parse(quoted.body.expiresAt) > Date.now(), 'Real quote was already expired.');
    assertPrivateFieldsAbsent(quoted.body);
    if (test.kind === 'evm') {
      requireCheck(quoted.body.transaction.chainId === test.chainId && quoted.body.transaction.value === '0', 'EVM payment context was incorrect.');
      requireCheck(/^0x[0-9a-f]{64}$/i.test(quoted.body.protocolOrderId ?? '') && quoted.body.transaction.data.toLowerCase().endsWith(quoted.body.protocolOrderId.slice(2).toLowerCase()), 'EVM payment was not bound to the verified protocol order.');
      requireCheck(quoted.body.estimatedSeconds === undefined && quoted.body.warnings?.length > 0, 'EVM finality warning was absent or total-time estimate misleading.');
    }
    const idempotencyKey = randomUUID();
    const created = await request(server, '/api/orders', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ quoteId: quoted.body.id }) });
    requireCheck(created.response.status === 201 && typeof created.body.accessToken === 'string', 'Unsigned order creation failed.');
    requireCheck(created.body.order.status === 'awaiting_signature' && created.body.order.sourceTxHash === undefined, 'Created order was not unsigned.');
    const missing = await request(server, `/api/orders/${created.body.order.id}`);
    requireCheck(missing.response.status === 401, 'Order without a token was accessible.');
    const incorrect = await request(server, `/api/orders/${created.body.order.id}`, { headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` } });
    requireCheck(incorrect.response.status === 404, 'Order with an incorrect token was accessible.');
    await checkRecovery(server, created.body, quoted.body.id, idempotencyKey);
    orders.push({ original: created.body, quoteId: quoted.body.id, idempotencyKey });
    quoteSnapshots.push({ routeId: route.id, amount: quoted.body.amount, expectedReceive: quoted.body.expectedReceive, minReceive: quoted.body.minReceive });
    passed(`real ${test.routeId} validated quote, unsigned order, token isolation and stable idempotency`);
  }

  stage = 'same-database process restart';
  await stopServer(server);
  server = await startServer(dataDir);
  for (const saved of orders) await checkRecovery(server, saved.original, saved.quoteId, saved.idempotencyKey);
  passed('clean restart preserves order, original token and idempotent recovery');

  stage = 'live SQLite backup and isolated restore';
  const backupPath = join(tempRoot, 'snapshots', 'funding.sqlite');
  const backup = launch(['scripts/backup.mjs', backupPath], server.env);
  const backupEnd = await waitExit(backup, 20_000);
  requireCheck(backupEnd.code === 0, 'VACUUM INTO backup or its integrity check failed.');
  requireCheck(JSON.parse(backup.output).status === 'ok', 'Backup script did not report verified success.');
  requireCheck(((await stat(backupPath)).mode & 0o777) === 0o600, 'Backup file permissions are not private.');
  const duplicate = launch(['scripts/backup.mjs', backupPath], server.env);
  requireCheck((await waitExit(duplicate, 20_000)).code !== 0, 'Backup unexpectedly overwrote an existing snapshot.');
  await stopServer(server);
  const restoredDir = join(tempRoot, 'restored'); await mkdir(restoredDir, { mode: 0o700 });
  await copyFile(backupPath, join(restoredDir, 'funding.sqlite'));
  const restored = await startServer(restoredDir);
  for (const saved of orders) await checkRecovery(restored, saved.original, saved.quoteId, saved.idempotencyKey);
  await stopServer(restored);
  passed('live VACUUM INTO snapshot, integrity check, overwrite refusal and isolated restore');

  await cleanup();
  requireCheck(children.size === 0, 'Test child processes remained after cleanup.');
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), status: 'passed', node: process.version, checks,
    quoteSnapshots,
    transactionBroadcast: false, cleanup: 'all test processes stopped and temporary files removed',
    limitation: 'Node 24 process/backup acceptance only. No Docker startup, wallet signature, or end-to-end funds transfer was performed.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, message: error instanceof AcceptanceError ? error.message : 'Unexpected local I/O or response error; inspect the current stage without exposing credentials.' }));
  process.exitCode = 1;
} finally {
  await cleanup();
}
