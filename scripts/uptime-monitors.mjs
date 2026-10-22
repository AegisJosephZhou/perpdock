import { pathToFileURL } from 'node:url';

const API = 'https://incidents.betterstack.com/api/v2/monitors';

/** Build a reviewable plan without credentials, network calls or account changes. */
export function uptimePlan(origin) {
  let url;
  try { url = new URL(origin); } catch { throw new Error('UPTIME_ORIGIN must be an HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
      url.pathname !== '/' || !/^[a-z\d.-]+\.[a-z]{2,63}$/i.test(url.hostname) ||
      /(?:^|\.)(?:localhost|local|test|invalid|example)$/i.test(url.hostname)) {
    throw new Error('UPTIME_ORIGIN must be an HTTPS DNS origin without credentials, port, path or query.');
  }
  const targets = [
    ['page', '/'], ['health', '/api/health'], ['config', '/api/config'], ['ready', '/api/ready'],
  ];
  return targets.map(([name, path]) => ({
    pronounceable_name: `Dock ${url.hostname} ${name}`,
    url: `${url.origin}${path}`, monitor_type: 'expected_status_code', expected_status_codes: [200],
    http_method: 'GET', check_frequency: 60, request_timeout: 10,
    follow_redirects: false, remember_cookies: false, verify_ssl: true,
    confirmation_period: 120, recovery_period: 60, regions: ['us', 'eu', 'as'],
    email: true, sms: false, call: false, push: false, paused: false,
  }));
}

function sameValue(left, right, key) {
  if (Array.isArray(left) && Array.isArray(right)) return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (key === 'http_method' && typeof left === 'string' && typeof right === 'string') return left.toUpperCase() === right.toUpperCase();
  return left === right;
}

/** Explicit operator-only apply. Never called by the app, container or test startup. */
export async function applyUptimePlan(plan, { token, team, fetcher = fetch } = {}) {
  if (!token || /\s/.test(token)) throw new Error('BETTERSTACK_API_TOKEN is required for --apply.');
  if (team && (team.length > 100 || /[\r\n]/.test(team))) throw new Error('BETTERSTACK_TEAM_NAME is invalid.');
  const request = async (url, method = 'GET', body) => {
    let response;
    try {
      response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('Better Stack request failed; inspect the account before retrying an uncertain create.'); }
    // Do not print provider response bodies, request headers or environment values.
    if (!response.ok) throw new Error(`Better Stack returned HTTP ${response.status}; no automatic retry or plan upgrade was attempted.`);
    try { return await response.json(); } catch { throw new Error('Better Stack returned an invalid response.'); }
  };
  const results = [];
  for (const desired of plan) {
    const matches = [];
    for (let page = 1; ; page++) {
      if (page > 20) throw new Error('Too many monitor pages; inspect matching monitors manually.');
      const query = new URLSearchParams({ url: desired.url, page: String(page), per_page: '100', ...(team ? { team_name: team } : {}) });
      const listing = await request(`${API}?${query}`);
      if (!Array.isArray(listing.data)) throw new Error('Better Stack returned an invalid monitor list.');
      matches.push(...listing.data.filter(item => item?.attributes?.url === desired.url));
      if (!listing.pagination?.next) break;
      // Construct the next page locally: never forward credentials to a returned URL.
    }
    if (matches.length > 1 || (matches.length === 1 && matches[0].attributes.pronounceable_name !== desired.pronounceable_name)) {
      throw new Error('An existing monitor conflicts with this plan; review it in Better Stack before applying.');
    }
    const existing = matches[0];
    let action = 'unchanged';
    let monitor = existing;
    if (!existing) {
      monitor = (await request(API, 'POST', { ...desired, ...(team ? { team_name: team } : {}) })).data;
      action = 'created';
    } else if (!Object.entries(desired).every(([key, value]) => sameValue(existing.attributes[key], value, key))) {
      if (!/^\d+$/.test(String(existing.id))) throw new Error('Better Stack returned an invalid monitor ID.');
      monitor = (await request(`${API}/${existing.id}`, 'PATCH', { ...desired, ...(team ? { team_name: team } : {}) })).data;
      action = 'updated';
    }
    if (!monitor || !/^\d+$/.test(String(monitor.id))) throw new Error('Better Stack returned an invalid monitor ID.');
    const verified = (await request(`${API}/${monitor.id}`)).data;
    const actual = verified?.attributes;
    if (!actual || !Object.entries(desired).every(([key, value]) => sameValue(actual[key], value, key))) {
      throw new Error('Monitor readback did not match the plan; inspect the account before retrying.');
    }
    if (actual.effective_check_frequency !== 60) {
      throw new Error('Monitor is configured but effective checks are not 60 seconds; review the account plan or throttling. No upgrade was attempted.');
    }
    results.push({ name: desired.pronounceable_name, id: String(monitor.id), action, checkFrequencySeconds: 60,
      status: ['up', 'down', 'validating', 'pending', 'maintenance', 'paused'].includes(actual.status) ? actual.status : 'unknown' });
  }
  return results;
}

export async function runUptimeCommand(args, env, { fetcher = fetch, output = console.log } = {}) {
  if (args.some(arg => arg !== '--apply') || args.length > 1) throw new Error('Usage: node scripts/uptime-monitors.mjs [--apply]');
  const plan = uptimePlan(env.UPTIME_ORIGIN);
  if (!args.includes('--apply')) {
    output(JSON.stringify({ mode: 'plan', applied: false, monitors: plan }, null, 2));
    return;
  }
  const result = await applyUptimePlan(plan, { token: env.BETTERSTACK_API_TOKEN, team: env.BETTERSTACK_TEAM_NAME, fetcher });
  output(JSON.stringify({ mode: 'apply', monitors: result }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runUptimeCommand(process.argv.slice(2), process.env).catch(error => {
    console.error(error instanceof Error ? error.message : 'Uptime configuration failed.');
    process.exitCode = 1;
  });
}
