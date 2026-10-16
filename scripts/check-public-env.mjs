import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

// Only used by the public deployment entrypoint. Never echo configuration values:
// errors may be copied into support chats or container logs.
export function validatePublicEnvironment(env) {
  const domain = env.APP_DOMAIN || '';
  const labels = domain.split('.');
  if (domain.length > 253 || labels.length < 2 || isIP(domain) ||
      !labels.every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ||
      !/^[a-z]{2,63}$/i.test(labels.at(-1)) ||
      /(?:^|\.)(?:localhost|local|test|invalid|example)$/i.test(domain) ||
      /(?:^|\.)example\.(?:com|net|org)$/i.test(domain)) {
    throw new Error('APP_DOMAIN must be your real ASCII DNS hostname, without protocol, port, path, spaces, or example values.');
  }
  if (env.PUBLIC_ORIGIN !== `https://${domain}`) {
    throw new Error('PUBLIC_ORIGIN must exactly match https:// plus APP_DOMAIN.');
  }
  if (env.NODE_ENV !== 'production' || env.TRUST_PROXY_HOPS !== '1') {
    throw new Error('Public deployment requires production mode and exactly one trusted Caddy proxy.');
  }
  if (!/^[A-Za-z0-9_-]{43,512}$/.test(env.ORDER_TOKEN_SECRET || '')) {
    throw new Error('ORDER_TOKEN_SECRET must be a stable random base64url secret (at least 43 characters); generate 48 random bytes and keep it private.');
  }
  if (!['true', 'false'].includes(env.PAUSE_NEW_ORDERS)) {
    throw new Error('PAUSE_NEW_ORDERS must explicitly be true or false.');
  }
  if (env.WALLETCONNECT_PROJECT_ID !== undefined && env.WALLETCONNECT_PROJECT_ID !== '' &&
      !/^[a-f\d]{32}$/i.test(env.WALLETCONNECT_PROJECT_ID)) {
    throw new Error('WALLETCONNECT_PROJECT_ID must be a 32-character hexadecimal project ID, or empty to disable WalletConnect.');
  }
  const parseAmount = (value) => {
    if (!/^\d{1,5}(?:\.\d{1,6})?$/.test(value || '')) {
      throw new Error('MIN_AMOUNT and MAX_AMOUNT must be positive decimal USDT amounts with at most 6 decimals.');
    }
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  };
  const minimum = parseAmount(env.MIN_AMOUNT);
  const maximum = parseAmount(env.MAX_AMOUNT);
  if (minimum <= 0n || maximum < minimum || maximum > 10_000_000_000n) {
    throw new Error('Amount limits must be positive, ordered, and no greater than the reviewed 10000 USDT route limit.');
  }
  return { paused: env.PAUSE_NEW_ORDERS === 'true' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = validatePublicEnvironment(process.env);
    console.info(`Public deployment configuration validated; new orders ${result.paused ? 'paused' : 'enabled'}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Public deployment configuration is invalid.');
    process.exitCode = 1;
  }
}
