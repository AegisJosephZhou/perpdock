import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runCli, validateOptions, verifyDeployment, writeReport } from '../scripts/verify-public-deployment.mjs';

// Every remote response is synthetic. No network requests, server, wallet or database.
const origin = 'https://deposit.perpex.ai';
const secret = 'DO_NOT_ECHO_PROVIDER_SECRET';
const html = '<!doctype html><html><head><title>Perpex · 存入 Hyperliquid</title><script type="module" src="/assets/app-a1.js"></script><link rel="stylesheet" href="/assets/app-b2.css"></head><body><div id="root"></div></body></html>';
const security = {
  'content-type': 'text/html; charset=utf-8', 'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self' https://api.trongrid.io https://api.tronstack.io https://tron-rpc.publicnode.com; object-src 'none'; frame-ancestors 'none'; script-src-attr 'none'",
};
const wcProjectId = '0123456789abcdef'.repeat(2);
const wcConnect = 'wss://relay.walletconnect.com wss://relay.walletconnect.org https://verify.walletconnect.com https://verify.walletconnect.org https://ethereum.publicnode.com https://arbitrum-one.publicnode.com https://base.drpc.org https://optimism.publicnode.com https://polygon-bor-rpc.publicnode.com https://bsc-rpc.publicnode.com';
const wcSecurity = { ...security, 'content-security-policy': security['content-security-policy'].replace('https://tron-rpc.publicnode.com;', `https://tron-rpc.publicnode.com ${wcConnect};`) + '; frame-src https://verify.walletconnect.org' };
const config = () => ({ appName: 'Perpex', network: 'mainnet', paused: true, limits: { minAmount: '10', maxAmount: '100' },
  routes: [{ id: 'ethereum-usdt-hypercore', sourceChainId: 1, symbol: 'USDT', decimals: 6, walletType: 'evm', available: true, reason: secret,
    sourceToken: secret, privateMetadata: secret }], privateMetadata: secret });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
function fixture(override) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const replacement = await override?.(url, options, calls.length);
    if (replacement !== undefined) return replacement;
    if (url === `${origin}/`) return new Response(html, { headers: security });
    if (url === 'http://deposit.perpex.ai/') return new Response(null, { status: 308, headers: { location: `${origin}/` } });
    if (url === `${origin}/assets/app-a1.js`) return new Response('console.log("Perpex");', { headers: { 'content-type': 'text/javascript' } });
    if (url === `${origin}/assets/app-b2.css`) return new Response('body { margin: 0; }', { headers: { 'content-type': 'text/css' } });
    if (url === `${origin}/api/config`) return json(config());
    if (url === `${origin}/api/health`) {
      if (options.headers.Origin === 'https://origin-check.invalid') return json({ error: { code: 'ORIGIN_NOT_ALLOWED', message: secret } }, 403);
      return json({ status: 'ok', version: '0.1.0', privateMetadata: secret }, 200,
        options.headers.Origin ? { 'access-control-allow-origin': origin } : {});
    }
    throw new Error(`Unexpected fixture request ${secret}`);
  };
  return { calls, fetchImpl };
}
async function inspect(override, options = {}) {
  const harness = fixture(override);
  const report = await verifyDeployment({ origin, ...options }, { fetchImpl: harness.fetchImpl, now: () => new Date('2026-10-14T12:00:00.000Z') });
  return { report, ...harness };
}
const failure = (report, id, code) => {
  assert.equal(report.status, 'failed');
  assert.equal(report.checks.find(check => check.id === id)?.status, 'failed');
  if (code) assert.equal(report.checks.find(check => check.id === id)?.code, code);
  assert.equal(JSON.stringify(report).includes(secret), false);
};

test('complete paused deployment yields bounded evidence with only GET allowlisted requests', async () => {
  const { report, calls } = await inspect();
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.length, 8);
  assert.equal(report.observedAt, '2026-10-14T12:00:00.000Z');
  assert.equal(report.healthVersion, '0.1.0');
  assert.equal(report.assets.length, 2);
  assert.match(report.htmlSha256, /^[a-f0-9]{64}$/);
  assert.match(report.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.routeSnapshot, [{ id: 'ethereum-usdt-hypercore', sourceChainId: 1, symbol: 'USDT', decimals: 6, walletType: 'evm', available: true }]);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.ok(report.unverified.some(value => value.includes('Exact reviewed route registry')));
  assert.ok(report.unverified.some(value => value.includes('build identity')));
  assert.ok(report.unverified.some(value => value.includes('backup restore')));
  const urls = new Set([`${origin}/`, 'http://deposit.perpex.ai/', `${origin}/api/health`, `${origin}/api/config`, `${origin}/assets/app-a1.js`, `${origin}/assets/app-b2.css`]);
  for (const call of calls) {
    assert.ok(urls.has(call.url));
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'manual');
    assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.body, undefined);
    assert.equal(call.options.headers.Authorization, undefined); assert.equal(call.options.headers.Cookie, undefined);
  }
});

test('invalid or credential-bearing origins fail before any request and do not echo the value', async () => {
  for (const value of [undefined, '', 'http://deposit.perpex.ai', `https://${secret}:password@deposit.perpex.ai`, `https://deposit.perpex.ai/?token=${secret}`,
    'https://deposit.perpex.ai/path', `https://deposit.perpex.ai/#${secret}`, 'https://localhost', 'https://127.0.0.1', 'https://[::1]',
    'https://funding.local', 'https://funding.example.com', 'https://deposit.perpex.ai:8787', 'https://deposit.perpex.ai\\evil', ' https://deposit.perpex.ai']) {
    let requests = 0;
    await assert.rejects(() => verifyDeployment({ origin: value }, { fetchImpl: async () => { requests++; } }), error => {
      assert.equal(error.message.includes(secret), false); return true;
    });
    assert.equal(requests, 0);
  }
  assert.equal(validateOptions({ origin: `${origin}/` }).origin, origin);
});

test('invalid expected limits are rejected without floating point rounding', () => {
  for (const mutation of [{ expectedMin: '0' }, { expectedMin: '101' }, { expectedMax: '10001' },
    { expectedMin: '10.0000001' }, { expectedMax: '1e2' }, { expectedMax: '0100' }, { timeoutMs: 0 }]) {
    assert.throws(() => validateOptions({ origin, ...mutation }));
  }
});

test('a process with TLS verification disabled is refused before network access', async () => {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let requests = 0;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    await assert.rejects(() => verifyDeployment({ origin }, { fetchImpl: async () => { requests++; } }), /TLS_VERIFICATION_DISABLED/);
    assert.equal(requests, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
});

test('API and asset redirects are never followed; HTTP redirect must match approved origin exactly', async () => {
  for (const location of [`https://evil.invalid/?key=${secret}`, `${origin}/?key=${secret}`, `http://deposit.perpex.ai/`, '/']) {
    const { report, calls } = await inspect(url => url.startsWith('http:') ? new Response(null, { status: 302, headers: { location } }) : undefined);
    failure(report, 'http_to_https', 'INVALID_REDIRECT_TARGET');
    assert.ok(calls.every(call => !call.url.includes('evil.invalid') && !call.url.includes(secret)));
  }
  const { report, calls } = await inspect(url => url === `${origin}/api/config`
    ? new Response('redirect', { status: 302, headers: { location: `https://evil.invalid/${secret}` } }) : undefined);
  failure(report, 'paused_config', 'UNEXPECTED_HTTP_STATUS');
  assert.ok(calls.every(call => !call.url.includes('evil.invalid')));
});

test('unexpected fetch redirect metadata is refused even if a fetch implementation follows', async () => {
  const { report } = await inspect(url => {
    if (url !== `${origin}/api/config`) return;
    const response = json(config()); Object.defineProperty(response, 'redirected', { value: true }); return response;
  });
  failure(report, 'paused_config', 'UNEXPECTED_REDIRECT');
});

test('unsafe resource paths and base tags fail without fetching the unapproved resource', async () => {
  for (const modified of [html.replace('/assets/app-a1.js', `https://evil.invalid/${secret}.js`),
    html.replace('/assets/app-a1.js', `/assets/app-a1.js?key=${secret}`), html.replace('/assets/app-a1.js', '/api/orders'),
    html.replace('<head>', '<head><base href="https://evil.invalid/">'), html.replace('/assets/app-a1.js', '/assets/../api/config')]) {
    const { report, calls } = await inspect(url => url === `${origin}/` ? new Response(modified, { headers: security }) : undefined);
    failure(report, 'https_html'); assert.ok(calls.every(call => !call.url.includes(secret) && !call.url.includes('evil.invalid') && !call.url.includes('/api/orders')));
  }
});

test('SPA fallback is rejected for JavaScript even with a dishonest JavaScript MIME', async () => {
  for (const type of ['text/html', 'text/javascript']) {
    const { report } = await inspect(url => url.endsWith('.js') ? new Response(html, { headers: { 'content-type': type } }) : undefined);
    failure(report, 'built_assets', type === 'text/html' ? 'INVALID_ASSET_MIME' : 'INVALID_ASSET_BODY');
  }
});

for (const asset of [{ extension: '.js', mime: 'text/javascript' }, { extension: '.css', mime: 'text/css' }]) {
  test(`HTML fallback with BOM, comments or tag-only errors is rejected for ${asset.extension}`, async () => {
    for (const body of [html, `\uFEFF \n${html}`, `<!-- reverse proxy fallback -->\n${html}`,
      `\uFEFF\n<!-- proxy --> \n<!-- ${secret} -->\n${html}`, '<!-- unfinished proxy fallback',
      '<!-- fallback --><main>Unavailable</main>', '\uFEFF<!-- fallback --><meta charset="utf-8">']) {
      const { report } = await inspect(url => url.endsWith(asset.extension)
        ? new Response(body, { headers: { 'content-type': asset.mime } }) : undefined);
      failure(report, 'built_assets', 'INVALID_ASSET_BODY');
    }
  });
}

test('BOM and whitespace before real JavaScript and CSS remain valid asset observations', async () => {
  const { report } = await inspect(url => {
    if (url.endsWith('.js')) return new Response('\uFEFF \n/* app */ console.log("Perpex");', { headers: { 'content-type': 'text/javascript' } });
    if (url.endsWith('.css')) return new Response('\uFEFF \n/* styles */ body { color: #fff; }', { headers: { 'content-type': 'text/css' } });
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.assets.length, 2);
});

test('security headers accept reordered reviewed CSP but reject overrides and missing controls', async () => {
  const safe = security['content-security-policy'].split(';').reverse().join(';');
  assert.equal((await inspect(url => url === `${origin}/` ? new Response(html, { headers: { ...security, 'content-security-policy': safe } }) : undefined)).report.status, 'passed');
  for (const mutation of [{ 'x-content-type-options': '' }, { 'strict-transport-security': 'max-age=0' }, { 'x-frame-options': '' },
    { 'content-security-policy': `${safe}; script-src-elem *` }, { 'content-security-policy': `${safe}; script-src 'unsafe-eval'` },
    { 'content-security-policy': safe.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'") },
    { 'content-security-policy': safe.replace('https://api.trongrid.io', 'https://unreviewed.invalid') }]) {
    failure((await inspect(url => url === `${origin}/` ? new Response(html, { headers: { ...security, ...mutation } }) : undefined)).report, 'security_headers');
  }
});

test('accepts the exact optional WalletConnect CSP only when public configuration agrees', async () => {
  const { report, calls } = await inspect(url => {
    if (url === `${origin}/`) return new Response(html, { headers: wcSecurity });
    if (url === `${origin}/api/config`) return json({ ...config(), walletConnect: { projectId: wcProjectId, ignored: secret } });
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.configSnapshot.walletConnectConfigured, true);
  assert.equal(JSON.stringify(report).includes(wcProjectId), false);
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.ok(calls.every(call => !call.url.includes('walletconnect') && !call.url.includes('publicnode')));
  for (const configured of [true, false]) {
    const { report: mismatch } = await inspect(url => {
      if (url === `${origin}/` && !configured) return new Response(html, { headers: wcSecurity });
      if (url === `${origin}/api/config` && configured) return json({ ...config(), walletConnect: { projectId: wcProjectId } });
    });
    failure(mismatch, 'paused_config', 'WALLETCONNECT_CSP_CONFIG_MISMATCH');
  }
});

test('rejects partial or expanded WalletConnect CSP and invalid advertised IDs', async () => {
  for (const csp of [
    wcSecurity['content-security-policy'].replace('wss://relay.walletconnect.com', 'wss://*.walletconnect.com'),
    wcSecurity['content-security-policy'].replace('https://base.drpc.org', 'https://unreviewed.invalid'),
    wcSecurity['content-security-policy'].replace('wss://relay.walletconnect.org ', ''),
    wcSecurity['content-security-policy'].replace('; frame-src https://verify.walletconnect.org', ''),
    wcSecurity['content-security-policy'].replace('frame-src https://verify.walletconnect.org', 'frame-src https:'),
    security['content-security-policy'] + '; frame-src https://verify.walletconnect.org',
  ]) {
    const { report } = await inspect(url => url === `${origin}/`
      ? new Response(html, { headers: { ...security, 'content-security-policy': csp } }) : undefined);
    failure(report, 'security_headers', 'UNREVIEWED_CSP');
  }
  for (const walletConnect of [null, {}, { projectId: secret }, { projectId: '' }, { projectId: 'a'.repeat(31) }]) {
    const { report } = await inspect(url => url === `${origin}/api/config` ? json({ ...config(), walletConnect }) : undefined);
    failure(report, 'paused_config', 'INVALID_WALLETCONNECT_CONFIG');
  }
});

test('pause and exact effective amount range fail independently of healthy process', async () => {
  for (const mutation of [{ paused: false }, { limits: { minAmount: '10', maxAmount: '1000' } }, { network: 'testnet' }, { appName: secret },
    { limits: { minAmount: '10.000001', maxAmount: '100' } }]) {
    const { report } = await inspect(url => url.endsWith('/api/config') ? json({ ...config(), ...mutation }) : undefined);
    failure(report, 'paused_config'); assert.equal(report.checks.find(check => check.id === 'health').status, 'passed');
  }
  const { report } = await inspect(url => url.endsWith('/api/config') ? json({ ...config(), limits: { minAmount: '10.000000', maxAmount: '100.0' } }) : undefined);
  assert.equal(report.status, 'passed');
});

test('unavailable route snapshot remains honest and does not imply funds readiness', async () => {
  const body = config(); body.routes[0].available = false;
  const { report } = await inspect(url => url.endsWith('/api/config') ? json(body) : undefined);
  assert.equal(report.status, 'passed'); assert.equal(report.routeAvailability.available, 0);
  assert.match(report.routeAvailability.meaning, /does not prove/);
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('malformed or duplicate routes cannot enter the evidence report', async () => {
  for (const routes of [[], [config().routes[0], config().routes[0]], [{ ...config().routes[0], available: 'yes' }],
    [{ ...config().routes[0], id: `https://evil.invalid/?${secret}` }], [{ ...config().routes[0], symbol: secret }],
    [{ ...config().routes[0], decimals: 1.5 }], [{ ...config().routes[0], sourceChainId: '1' }]]) {
    const { report } = await inspect(url => url.endsWith('/api/config') ? json({ ...config(), routes }) : undefined);
    failure(report, 'paused_config', 'INVALID_ROUTES'); assert.equal(report.routeSnapshot, undefined);
  }
});

test('cache and Origin controls must work at the target', async () => {
  failure((await inspect((url, options) => url.endsWith('/api/health') && !options.headers.Origin
    ? json({ status: 'ok', version: '0.1.0' }, 200, { 'cache-control': 'public, max-age=600' }) : undefined)).report, 'health', 'API_CACHE_POLICY');
  failure((await inspect((_url, options) => options.headers.Origin === origin
    ? json({ status: 'ok' }, 200, { 'access-control-allow-origin': '*' }) : undefined)).report, 'same_origin');
  failure((await inspect((_url, options) => options.headers.Origin === 'https://origin-check.invalid'
    ? json({ status: 'ok' }, 200, { 'access-control-allow-origin': '*' }) : undefined)).report, 'foreign_origin');
});

test('malformed responses, raw errors and oversized streams never leak response contents', async () => {
  const replacements = [() => new Response(secret, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }),
    () => new Response(secret, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } }),
    () => json({ status: 'ok', version: secret }),
    () => new Response(secret, { headers: { 'content-length': String(1024 * 1024) } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(140 * 1024)); controller.close(); } })),
    () => { throw new Error(`Network failure ${secret}`); }];
  for (const replace of replacements) {
    const { report } = await inspect((url, options) => url.endsWith('/api/health') && !options.headers.Origin ? replace() : undefined);
    failure(report, 'health');
  }
});

test('deadline bounds a hanging fetch and a hanging response body', async () => {
  for (const replacement of [() => new Promise(() => {}), () => new Response(new ReadableStream({ start() {} }))]) {
    const { report } = await inspect((url, options) => url.endsWith('/api/health') && !options.headers.Origin ? replacement() : undefined, { timeoutMs: 15 });
    failure(report, 'health', 'REQUEST_TIMEOUT');
  }
});

test('reports have private mode and refuse existing paths and symlinks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpex-deployment-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'report.json');
  const { report } = await inspect(); await writeReport(report, path);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(() => writeReport({ overwritten: true }, path), /REPORT_WRITE_FAILED_OR_EXISTS/);
  const target = join(dir, 'existing.txt'); const link = join(dir, 'link.json'); await writeFile(target, secret); await symlink(target, link);
  await assert.rejects(() => writeReport(report, link), /REPORT_WRITE_FAILED_OR_EXISTS/);
  assert.equal(await readFile(target, 'utf8'), secret);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
});

test('CLI returns nonzero and still saves failed evidence; reports are never overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpex-deployment-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { report } = await inspect(url => url.endsWith('/api/config') ? json({ ...config(), paused: false }) : undefined);
  let out = ''; let err = ''; const output = { stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } }, verify: async () => report };
  const args = ['--origin', origin, '--report', join(dir, 'failed.json')];
  assert.equal(await runCli(args, output), 1); assert.equal(err, ''); assert.equal(JSON.parse(out).status, 'failed');
  assert.equal(JSON.parse(await readFile(args[3], 'utf8')).status, 'failed');
  out = ''; assert.equal(await runCli(args, output), 1); assert.match(err, /REPORT_WRITE_FAILED_OR_EXISTS/);
  assert.equal((out + err).includes(secret), false);
});

test('CLI success saves the report and keeps stdout limited to the result summary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'perpex-deployment-cli-pass-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { report } = await inspect(); let stdout = ''; let stderr = '';
  const code = await runCli(['--origin', origin, '--report', join(dir, 'passed.json'), '--expected-min', '10', '--expected-max', '100'], {
    verify: async options => { assert.equal(options.origin, origin); return report; },
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
  });
  assert.equal(code, 0); assert.equal(stderr, ''); assert.equal(JSON.parse(stdout).status, 'passed');
  assert.deepEqual(JSON.parse(stdout).failedChecks, []);
  assert.equal(JSON.parse(stdout).routeSnapshot, undefined);
  assert.equal(JSON.parse(await readFile(join(dir, 'passed.json'), 'utf8')).status, 'passed');
});

test('CLI requires explicit arguments, rejects credential-bearing values, and help makes no requests', async () => {
  for (const args of [[], ['--origin', origin], ['--origin', `https://${secret}:password@deposit.perpex.ai`, '--report', '/unused'],
    ['--origin', origin, '--report', '/unused', '--origin', origin], ['--origin', origin, '--report', '/unused', '--insecure', 'true']]) {
    let calls = 0; let output = '';
    const code = await runCli(args, { verify: async () => { calls++; }, stdout: { write: value => { output += value; } }, stderr: { write: value => { output += value; } } });
    assert.equal(code, 1); assert.equal(calls, 0); assert.equal(output.includes(secret), false);
  }
  const child = spawnSync(process.execPath, ['scripts/verify-public-deployment.mjs', '--help'], { encoding: 'utf8' });
  assert.equal(child.status, 0); assert.match(child.stdout, /GET-only/); assert.equal(child.stderr, '');
  const invalid = spawnSync(process.execPath, ['scripts/verify-public-deployment.mjs'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /ORIGIN_AND_REPORT_REQUIRED/);
});
