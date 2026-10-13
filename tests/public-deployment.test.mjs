import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePublicEnvironment } from '../scripts/check-public-env.mjs';

// Synthetic configuration only. No DNS requests or production secrets are read.
const base = {
  APP_DOMAIN: 'funding.perpdock.com', PUBLIC_ORIGIN: 'https://funding.perpdock.com',
  NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', ORDER_TOKEN_SECRET: 'x'.repeat(64),
  PAUSE_NEW_ORDERS: 'true', MIN_AMOUNT: '10', MAX_AMOUNT: '100',
};
test('validates paused and enabled single-proxy configurations', () => {
  assert.deepEqual(validatePublicEnvironment(base), { paused: true });
  assert.deepEqual(validatePublicEnvironment({ ...base, PAUSE_NEW_ORDERS: 'false' }), { paused: false });
});
for (const domain of ['', 'localhost', '127.0.0.1', 'https://funding.perpdock.com',
  'funding.perpdock.com:443', 'funding.perpdock.com/path', '*.perpdock.com',
  'funding.perpdock.com\n:80', 'funding.perpdock.com other.com', 'funding.example.com',
  'funding.test', '-bad.perpdock.com', 'bad-.perpdock.com', 'a'.repeat(64) + '.com']) {
  test(`rejects invalid hostname ${JSON.stringify(domain)}`, () => {
    assert.throws(() => validatePublicEnvironment({ ...base, APP_DOMAIN: domain }), /APP_DOMAIN/);
  });
}
test('rejects wrong origin, proxy count and production mode', () => {
  for (const mutation of [{ PUBLIC_ORIGIN: 'http://funding.perpdock.com' },
    { PUBLIC_ORIGIN: 'https://other.perpdock.com' }, { TRUST_PROXY_HOPS: '2' }, { NODE_ENV: 'development' }]) {
    assert.throws(() => validatePublicEnvironment({ ...base, ...mutation }));
  }
});
test('requires a stable secret without disclosing the rejected value', () => {
  for (const secret of ['', 'do-not-print-me', 'unsafe\n'.repeat(10)]) {
    assert.throws(() => validatePublicEnvironment({ ...base, ORDER_TOKEN_SECRET: secret }), error => {
      assert.match(error.message, /ORDER_TOKEN_SECRET/);
      if (secret) assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});
test('requires explicit pause state and conservative precise amount limits', () => {
  for (const mutation of [{ PAUSE_NEW_ORDERS: '' }, { PAUSE_NEW_ORDERS: 'yes' },
    { MIN_AMOUNT: '0' }, { MIN_AMOUNT: '101' }, { MAX_AMOUNT: '10001' },
    { MAX_AMOUNT: '1e3' }, { MIN_AMOUNT: '1.0000001' }]) {
    assert.throws(() => validatePublicEnvironment({ ...base, ...mutation }));
  }
});
