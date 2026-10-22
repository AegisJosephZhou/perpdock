import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uptimePlan, applyUptimePlan, runUptimeCommand } from '../scripts/uptime-monitors.mjs';

const origin = 'https://dock.example.com';
test('default CLI is an offline review of four 60-second GET monitors', async () => {
  let calls = 0; let output;
  await runUptimeCommand([], { UPTIME_ORIGIN: origin, BETTERSTACK_API_TOKEN: 'must-not-leak' }, {
    fetcher: async () => { calls++; throw new Error('no network allowed'); }, output: value => { output = value; },
  });
  const plan = JSON.parse(output);
  assert.equal(calls, 0); assert.equal(plan.applied, false);
  assert.deepEqual(plan.monitors.map(m => new URL(m.url).pathname), ['/', '/api/health', '/api/config', '/api/ready']);
  assert.ok(plan.monitors.every(m => m.check_frequency === 60 && m.http_method === 'GET' && m.verify_ssl && !m.follow_redirects));
  assert.ok(!output.includes('must-not-leak'));
});
test('rejects URLs that could carry credentials or change request semantics', () => {
  for (const value of ['http://dock.example.com', 'https://secret@dock.example.com', `${origin}/private`, `${origin}?token=secret`, `${origin}#x`, 'https://127.0.0.1', 'https://localhost', 'https://dock.example.com:9443']) {
    assert.throws(() => uptimePlan(value));
  }
});
test('apply creates, verifies effective interval, and is idempotent on a second run', async () => {
  const plan = uptimePlan(origin).slice(0, 1); const records = []; const methods = [];
  const fetcher = async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(new URL(url).origin, 'https://incidents.betterstack.com');
    methods.push(init.method);
    if (init.method === 'POST') {
      records.push({ id: '123', attributes: { ...JSON.parse(init.body), effective_check_frequency: 60, status: 'pending' } });
      return Response.json({ data: records[0] });
    }
    return Response.json(new URL(url).pathname.endsWith('/123') ? { data: records[0] } : { data: records, pagination: { next: null } });
  };
  assert.equal((await applyUptimePlan(plan, { token: 'synthetic', fetcher }))[0].action, 'created');
  assert.equal((await applyUptimePlan(plan, { token: 'synthetic', fetcher }))[0].action, 'unchanged');
  assert.equal(methods.filter(m => m === 'POST').length, 1);
});
test('will not overwrite a conflicting account monitor', async () => {
  const plan = uptimePlan(origin).slice(0, 1);
  await assert.rejects(applyUptimePlan(plan, { token: 'synthetic', fetcher: async (_url, init) => {
    assert.equal(init.method, 'GET');
    return Response.json({ data: [{ id: '1', attributes: { ...plan[0], pronounceable_name: 'Another operator' } }] });
  } }), /conflicts/);
});
test('does not claim minute monitoring if the actual account frequency is longer', async () => {
  const plan = uptimePlan(origin).slice(0, 1);
  const monitor = { id: '1', attributes: { ...plan[0], effective_check_frequency: 180 } };
  await assert.rejects(applyUptimePlan(plan, { token: 'synthetic', fetcher: async url => Response.json(
    new URL(url).pathname.endsWith('/1') ? { data: monitor } : { data: [monitor] },
  ) }), /not 60 seconds/);
});
test('readback URL paths remain case-sensitive, while HTTP method normalization is supported', async () => {
  const plan = [uptimePlan(origin)[3]];
  const monitor = { id: '1', attributes: { ...plan[0], http_method: 'get', effective_check_frequency: 60 } };
  await assert.rejects(applyUptimePlan(plan, { token: 'synthetic', fetcher: async url => Response.json(
    new URL(url).pathname.endsWith('/1')
      ? { data: { ...monitor, attributes: { ...monitor.attributes, url: `${origin}/API/READY` } } }
      : { data: [monitor] },
  ) }), /readback did not match/);
});
test('sanitizes request failures and does not retry uncertain creates', async () => {
  const plan = uptimePlan(origin).slice(0, 1); let creates = 0;
  await assert.rejects(applyUptimePlan(plan, { token: 'secret-token', fetcher: async (_url, init) => {
    if (init.method === 'GET') return Response.json({ data: [] });
    creates++; throw new Error('secret-token response private@example.com');
  } }), error => !error.message.includes('secret-token') && /before retrying/.test(error.message));
  assert.equal(creates, 1);
});
test('pagination never forwards credentials to a URL returned by the API', async () => {
  const plan = uptimePlan(origin).slice(0, 1); const urls = [];
  const monitor = { id: '1', attributes: { ...plan[0], effective_check_frequency: 60 } };
  await applyUptimePlan(plan, { token: 'synthetic', fetcher: async url => {
    urls.push(url);
    if (new URL(url).searchParams.get('page') === '1') return Response.json({ data: [], pagination: { next: 'https://evil.invalid/collect' } });
    return Response.json(new URL(url).pathname.endsWith('/1') ? { data: monitor } : { data: [monitor] });
  } });
  assert.ok(urls.every(url => new URL(url).origin === 'https://incidents.betterstack.com'));
});
