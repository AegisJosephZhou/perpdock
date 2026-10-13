import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class AppError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 400) {
    super(message);
  }
}

export const newId = (): string => randomBytes(24).toString('base64url');
export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
export const orderToken = (secret: string, orderId: string): string =>
  createHmac('sha256', secret).update(`hl-funding:order:v1:${orderId}`).digest('base64url');
export const verifyToken = (token: string, expectedHash: string): boolean => {
  const actual = Buffer.from(hashSecret(token), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
};

/** Generated only for local development; a stable production secret is mandatory. */
export function loadTokenSecret(path: string, configured?: string, production = false): string {
  if (configured) {
    if (configured.length < 32) throw new Error('ORDER_TOKEN_SECRET must contain at least 32 characters.');
    return configured;
  }
  if (production) throw new Error('Production requires a stable ORDER_TOKEN_SECRET.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length < 32) throw new Error('Local order-token key is invalid.');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(48).toString('base64url');
  try {
    writeFileSync(path, secret, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length < 32) throw new Error('Local order-token key is invalid.');
    return existing;
  }
}

export function decimalUnits(value: string, decimals: number): bigint {
  if (!/^\d{1,40}(?:\.\d{1,30})?$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 30) {
    throw new AppError('INVALID_AMOUNT', '金额必须使用普通十进制数字。');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new AppError('INVALID_PRECISION', `金额最多支持 ${decimals} 位小数。`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function normalizeTxHash(hash: string, kind: 'tron' | 'evm'): string {
  if (kind === 'evm' && /^0x[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
  if (kind === 'tron' && /^(?:0x)?[0-9a-fA-F]{64}$/.test(hash)) return hash.replace(/^0x/, '').toLowerCase();
  throw new AppError('INVALID_TX_HASH', '交易哈希格式与来源网络不符。');
}
