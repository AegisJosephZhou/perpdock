/** GET-only checks for an explicitly selected, paused HTTPS deployment.
 * Never reads private configuration, creates orders, connects a wallet, or follows redirects.
 * A passed report is not deployment provenance, backup recovery, or funds acceptance.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

class CheckError extends Error {}
const requireCheck = (condition, code) => { if (!condition) throw new CheckError(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const JSON_LIMIT = 128 * 1024;
const HTML_LIMIT = 256 * 1024;
const ASSET_LIMIT = 4 * 1024 * 1024;

function amountUnits(value) {
  requireCheck(typeof value === 'string' && /^(?:0|[1-9]\d{0,4})(?:\.\d{1,6})?$/.test(value), 'INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  requireCheck(units > 0n && units <= 10_000_000_000n, 'INVALID_AMOUNT');
  return units;
}

export function validateOptions({ origin, expectedMin = '10', expectedMax = '100', timeoutMs = 45_000 }) {
  requireCheck(typeof origin === 'string' && origin.length <= 270 && !/\s/.test(origin), 'INVALID_HTTPS_ORIGIN');
  let url;
  try { url = new URL(origin); } catch { throw new CheckError('INVALID_HTTPS_ORIGIN'); }
  const labels = url.hostname.split('.');
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && !url.port &&
    url.pathname === '/' && !url.search && !url.hash && !isIP(url.hostname) && labels.length >= 2 &&
    labels.every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) &&
    /^[a-z]{2,63}$/i.test(labels.at(-1)) &&
    !/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/i.test(url.hostname) &&
    !/(?:^|\.)example\.(?:com|net|org)$/i.test(url.hostname), 'INVALID_HTTPS_ORIGIN');
  requireCheck(origin === url.origin || origin === `${url.origin}/`, 'INVALID_HTTPS_ORIGIN');
  requireCheck(amountUnits(expectedMin) <= amountUnits(expectedMax), 'INVALID_AMOUNT_RANGE');
  requireCheck(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000, 'INVALID_TIMEOUT');
  return { origin: url.origin, expectedMin, expectedMax, timeoutMs };
}

async function boundedBody(response, limit) {
  const length = response.headers.get('content-length');
  requireCheck(length === null || /^\d+$/.test(length), 'INVALID_CONTENT_LENGTH');
  requireCheck(length === null || Number(length) <= limit, 'RESPONSE_TOO_LARGE');
  requireCheck(response.body, 'EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      requireCheck(size <= limit, 'RESPONSE_TOO_LARGE');
      chunks.push(Buffer.from(next.value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

function jsonBody(result) {
  requireCheck(/^application\/json(?:\s*;|$)/i.test(result.headers.get('content-type') ?? ''), 'INVALID_JSON_MIME');
  try { return JSON.parse(result.bytes.toString('utf8')); } catch { throw new CheckError('INVALID_JSON'); }
}
function noStore(headers) {
  requireCheck((headers.get('cache-control') ?? '').split(',').some(value => value.trim().toLowerCase() === 'no-store'), 'API_CACHE_POLICY');
}
function securityHeaders(headers) {
  requireCheck(headers.get('x-content-type-options')?.toLowerCase() === 'nosniff', 'MISSING_NOSNIFF');
  requireCheck(['DENY', 'SAMEORIGIN'].includes(headers.get('x-frame-options')?.toUpperCase()), 'INVALID_FRAME_HEADER');
  const hsts = headers.get('strict-transport-security') ?? '';
  const maxAge = /(?:^|;)\s*max-age=(\d+)(?:\s*;|\s*$)/i.exec(hsts)?.[1];
  requireCheck(maxAge && Number(maxAge) >= 15_552_000, 'INVALID_HSTS');
  const directives = new Map();
  for (const part of (headers.get('content-security-policy') ?? '').split(';')) {
    const tokens = part.trim().split(/\s+/);
    if (!tokens[0]) continue;
    const name = tokens.shift().toLowerCase();
    requireCheck(!directives.has(name), 'DUPLICATE_CSP_DIRECTIVE');
    directives.set(name, tokens);
  }
  const exact = (name, expected) => {
    const actual = directives.get(name);
    requireCheck(actual && actual.length === expected.length && expected.every(item => actual.includes(item)), 'UNREVIEWED_CSP');
  };
  exact('default-src', ["'self'"]);
  exact('script-src', ["'self'"]);
  exact('object-src', ["'none'"]);
  exact('frame-ancestors', ["'none'"]);
  exact('connect-src', ["'self'", 'https://api.trongrid.io', 'https://api.tronstack.io', 'https://tron-rpc.publicnode.com']);
  if (directives.has('script-src-elem')) exact('script-src-elem', ["'self'"]);
  if (directives.has('script-src-attr')) exact('script-src-attr', ["'none'"]);
}

function builtAssets(html) {
  requireCheck(/<title>\s*Perpex(?:\s|[·|—-]|<\/title>)/i.test(html), 'UNEXPECTED_HTML_TITLE');
  requireCheck(!/<base\b/i.test(html), 'UNEXPECTED_BASE_ELEMENT');
  const assets = new Map();
  let scripts = 0;
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attrs = new Map();
    for (const attr of match[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      const name = attr[1].toLowerCase();
      requireCheck(!attrs.has(name), 'DUPLICATE_ASSET_ATTRIBUTE');
      attrs.set(name, attr[2] ?? attr[3] ?? attr[4]);
    }
    let path;
    let kind;
    if (match[1].toLowerCase() === 'script') {
      path = attrs.get('src'); kind = 'javascript'; scripts++;
    } else {
      const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
      if (rel.includes('stylesheet')) { path = attrs.get('href'); kind = 'css'; }
      else if (rel.includes('modulepreload')) { path = attrs.get('href'); kind = 'javascript'; }
      else continue;
    }
    requireCheck(typeof path === 'string' && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:js|css)$/.test(path), 'UNSAFE_ASSET_URL');
    requireCheck(path.endsWith(kind === 'css' ? '.css' : '.js'), 'INVALID_ASSET_EXTENSION');
    requireCheck(!assets.has(path) || assets.get(path) === kind, 'CONFLICTING_ASSET_TYPE');
    assets.set(path, kind);
    requireCheck(assets.size <= 16, 'TOO_MANY_ASSETS');
  }
  requireCheck(scripts > 0 && assets.size > 0, 'MISSING_BUILT_SCRIPT');
  return [...assets].map(([path, kind]) => ({ path, kind }));
}

function hasHtmlPrefix(bytes) {
  // Proxies may prepend comments or a BOM to their HTML fallback. Scan only the
  // already bounded body, without copying it once per leading comment.
  const text = bytes.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    while (offset < text.length && /[\s\uFEFF]/.test(text[offset])) offset++;
    if (!text.startsWith('<!--', offset)) break;
    const end = text.indexOf('-->', offset + 4);
    if (end === -1) return true;
    offset = end + 3;
  }
  return /^(?:<!doctype\b|<\/?[a-z][a-z\d:-]*(?:\s|\/?>))/i.test(text.slice(offset));
}

function configSnapshot(body) {
  requireCheck(isRecord(body) && body.appName === 'Perpex' && body.network === 'mainnet' && typeof body.paused === 'boolean' && isRecord(body.limits), 'INVALID_CONFIG');
  amountUnits(body.limits.minAmount); amountUnits(body.limits.maxAmount);
  requireCheck(Array.isArray(body.routes) && body.routes.length > 0 && body.routes.length <= 32, 'INVALID_ROUTES');
  const seen = new Set();
  const routes = body.routes.map(route => {
    requireCheck(isRecord(route) && typeof route.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(route.id) && !seen.has(route.id) &&
      Number.isSafeInteger(route.sourceChainId) && route.sourceChainId > 0 &&
      typeof route.symbol === 'string' && /^[A-Z][A-Z0-9]{0,11}$/.test(route.symbol) &&
      Number.isInteger(route.decimals) && route.decimals >= 0 && route.decimals <= 30 &&
      ['evm', 'tron'].includes(route.walletType) && typeof route.available === 'boolean', 'INVALID_ROUTES');
    seen.add(route.id);
    return { id: route.id, sourceChainId: route.sourceChainId, symbol: route.symbol, decimals: route.decimals, walletType: route.walletType, available: route.available };
  });
  return { config: { appName: body.appName, network: body.network, paused: body.paused,
    limits: { minAmount: body.limits.minAmount, maxAmount: body.limits.maxAmount } }, routes };
}

export async function verifyDeployment(options, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  const { origin, expectedMin, expectedMax, timeoutMs } = validateOptions(options);
  requireCheck(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS_VERIFICATION_DISABLED');
  const report = {
    schemaVersion: 1, observedAt: now().toISOString(), origin, status: 'failed',
    scope: 'GET-only paused HTTPS deployment checks; no orders, wallet actions, or funds acceptance.',
    expectedLimits: { minAmount: expectedMin, maxAmount: expectedMax }, checks: [], assets: [],
    unverified: ['Backend build identity, source commit and image digest', 'Expected frontend build identity (hashes are observations only)',
      'Exact reviewed route registry and executable quotes', 'DNS ownership, every resolved address, proxy topology and public port isolation',
      'Target containers, persistent storage, restart retention and backup restore', 'Server-side pause rejection during concurrent configuration changes',
      'Wallet/browser compatibility and source payment, Relay settlement and Hyperliquid Perps credit'],
  };
  const httpRoot = `${origin.replace(/^https:/, 'http:')}/`;
  const allowed = new Set([`${origin}/`, `${origin}/api/health`, `${origin}/api/config`, httpRoot]);
  async function request(url, { originHeader, limit = JSON_LIMIT, readBody = true } = {}) {
    requireCheck(allowed.has(url), 'REQUEST_NOT_ALLOWED');
    const controller = new AbortController();
    let timer;
    let response;
    try {
      return await Promise.race([
        (async () => {
          response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
            headers: { Accept: '*/*', ...(originHeader ? { Origin: originHeader } : {}) }, signal: controller.signal });
          requireCheck(!response.redirected && (!response.url || response.url === url), 'UNEXPECTED_REDIRECT');
          const bytes = readBody ? await boundedBody(response, limit) : Buffer.alloc(0);
          return { status: response.status, headers: response.headers, bytes };
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CheckError('REQUEST_TIMEOUT')); }, timeoutMs); }),
      ]);
    } catch (error) {
      throw error instanceof CheckError ? error : new CheckError('NETWORK_OR_RESPONSE_FAILURE');
    } finally {
      clearTimeout(timer); controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }
  async function check(id, operation) {
    try { await operation(); report.checks.push({ id, status: 'passed' }); }
    catch (error) { report.checks.push({ id, status: 'failed', code: error instanceof CheckError ? error.message : 'INVALID_RESPONSE' }); }
  }

  let htmlResponse;
  let assets;
  await check('https_html', async () => {
    htmlResponse = await request(`${origin}/`, { limit: HTML_LIMIT });
    requireCheck(htmlResponse.status === 200, 'UNEXPECTED_HTTP_STATUS');
    requireCheck(/^text\/html(?:\s*;|$)/i.test(htmlResponse.headers.get('content-type') ?? ''), 'INVALID_HTML_MIME');
    assets = builtAssets(htmlResponse.bytes.toString('utf8'));
    report.htmlSha256 = sha256(htmlResponse.bytes);
  });
  await check('security_headers', async () => {
    requireCheck(htmlResponse?.status === 200, 'HTML_UNAVAILABLE');
    securityHeaders(htmlResponse.headers);
  });
  await check('built_assets', async () => {
    requireCheck(assets, 'ASSETS_UNAVAILABLE');
    for (const asset of assets) {
      const url = `${origin}${asset.path}`;
      allowed.add(url);
      const response = await request(url, { limit: ASSET_LIMIT });
      requireCheck(response.status === 200, 'UNEXPECTED_HTTP_STATUS');
      const mime = response.headers.get('content-type') ?? '';
      requireCheck(asset.kind === 'css' ? /^text\/css(?:\s*;|$)/i.test(mime) : /^(?:application|text)\/javascript(?:\s*;|$)/i.test(mime), 'INVALID_ASSET_MIME');
      requireCheck(response.bytes.length > 0 && !hasHtmlPrefix(response.bytes), 'INVALID_ASSET_BODY');
      report.assets.push({ path: asset.path, kind: asset.kind, bytes: response.bytes.length, sha256: sha256(response.bytes) });
    }
  });
  await check('http_to_https', async () => {
    const response = await request(httpRoot, { readBody: false });
    requireCheck([301, 302, 307, 308].includes(response.status), 'HTTPS_REDIRECT_REQUIRED');
    let destination;
    try { destination = new URL(response.headers.get('location'), httpRoot); } catch { throw new CheckError('INVALID_REDIRECT_TARGET'); }
    requireCheck(destination.href === `${origin}/`, 'INVALID_REDIRECT_TARGET');
  });
  await check('health', async () => {
    const response = await request(`${origin}/api/health`);
    requireCheck(response.status === 200, 'UNEXPECTED_HTTP_STATUS'); noStore(response.headers);
    const body = jsonBody(response);
    requireCheck(isRecord(body) && body.status === 'ok' && typeof body.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,31})?$/.test(body.version), 'INVALID_HEALTH');
    report.healthVersion = body.version;
  });
  await check('paused_config', async () => {
    const response = await request(`${origin}/api/config`);
    requireCheck(response.status === 200, 'UNEXPECTED_HTTP_STATUS'); noStore(response.headers);
    const snapshot = configSnapshot(jsonBody(response));
    report.configSnapshot = snapshot.config; report.routeSnapshot = snapshot.routes;
    report.routeAvailability = { available: snapshot.routes.filter(route => route.available).length, total: snapshot.routes.length,
      meaning: 'Observed route gate only; does not prove quotes, payment verification or funds readiness.' };
    requireCheck(snapshot.config.paused, 'NEW_ORDERS_NOT_PAUSED');
    requireCheck(amountUnits(snapshot.config.limits.minAmount) === amountUnits(expectedMin) && amountUnits(snapshot.config.limits.maxAmount) === amountUnits(expectedMax), 'UNEXPECTED_AMOUNT_LIMITS');
  });
  await check('same_origin', async () => {
    const response = await request(`${origin}/api/health`, { originHeader: origin });
    requireCheck(response.status === 200 && response.headers.get('access-control-allow-origin') === origin, 'SAME_ORIGIN_REJECTED');
    noStore(response.headers);
    requireCheck(jsonBody(response)?.status === 'ok', 'INVALID_HEALTH');
  });
  await check('foreign_origin', async () => {
    const response = await request(`${origin}/api/health`, { originHeader: 'https://origin-check.invalid' });
    requireCheck(response.status === 403 && !response.headers.get('access-control-allow-origin'), 'FOREIGN_ORIGIN_ACCEPTED');
    noStore(response.headers);
    requireCheck(jsonBody(response)?.error?.code === 'ORIGIN_NOT_ALLOWED', 'INVALID_ORIGIN_REJECTION');
  });
  report.status = report.checks.every(item => item.status === 'passed') ? 'passed' : 'failed';
  return report;
}

export async function writeReport(report, path) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch { throw new CheckError('REPORT_WRITE_FAILED_OR_EXISTS'); }
  finally { await file?.close(); }
}

const USAGE = 'Usage: node scripts/verify-public-deployment.mjs --origin https://confirmed-host --report /new/report.json [--expected-min 10 --expected-max 100]\nGET-only checks; a pass does not establish build identity, restore readiness or funds acceptance.\n';
export async function runCli(args, { stdout = process.stdout, stderr = process.stderr, verify = verifyDeployment } = {}) {
  try {
    if (args.length === 1 && args[0] === '--help') { stdout.write(USAGE); return 0; }
    const values = new Map();
    for (let i = 0; i < args.length; i += 2) {
      requireCheck(['--origin', '--report', '--expected-min', '--expected-max'].includes(args[i]) &&
        typeof args[i + 1] === 'string' && args[i + 1].length > 0 && !args[i + 1].startsWith('--') && !values.has(args[i]), 'INVALID_ARGUMENTS');
      values.set(args[i], args[i + 1]);
    }
    requireCheck(values.has('--origin') && values.has('--report'), 'ORIGIN_AND_REPORT_REQUIRED');
    const options = validateOptions({ origin: values.get('--origin'), expectedMin: values.get('--expected-min'), expectedMax: values.get('--expected-max') });
    const report = await verify(options);
    await writeReport(report, values.get('--report'));
    stdout.write(`${JSON.stringify({ status: report.status, checks: report.checks.length, failedChecks: report.checks.filter(item => item.status !== 'passed').map(item => item.id), scope: report.scope })}\n`);
    return report.status === 'passed' ? 0 : 1;
  } catch (error) {
    stderr.write(`${JSON.stringify({ status: 'failed', code: error instanceof CheckError ? error.message : 'CHECK_FAILED' })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runCli(process.argv.slice(2));
