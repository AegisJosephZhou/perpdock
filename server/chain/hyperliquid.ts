import { z } from 'zod';
import { getAddress, parseUnits } from 'viem';
import type { Account } from '../../shared/types.js';
import { postJson, UpstreamError } from './http.js';

const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
export function evmAddress(value: string): string {
  try { const address = getAddress(value); if (/^0x0{40}$/i.test(address)) throw new Error(); return address; }
  catch { throw new UpstreamError('INVALID_ADDRESS', 'Hyperliquid 收款地址必须是有效的非零 0x 地址。', 400); }
}
export async function getAccount(address: string): Promise<Account> {
  address = evmAddress(address);
  const state = z.object({ marginSummary: z.object({ accountValue: decimal }), withdrawable: decimal }).parse(await postJson('https://api.hyperliquid.xyz/info', { type: 'clearinghouseState', user: address, dex: '' }));
  return { address, perpsUsdc: state.marginSummary.accountValue, withdrawableUsdc: state.withdrawable, observedAt: new Date().toISOString() };
}

const LedgerEntry = z.object({ time: z.number().int(), hash: z.string(), delta: z.record(z.string(), z.unknown()) });
export type Ledger = z.infer<typeof LedgerEntry>[];
export async function getLedger(address: string, startTime: number, endTime?: number): Promise<Ledger> {
  return z.array(LedgerEntry).parse(await postJson('https://api.hyperliquid.xyz/info', { type: 'userNonFundingLedgerUpdates', user: evmAddress(address), startTime, ...(endTime === undefined ? {} : { endTime }) }));
}

/** Bounded historical recovery. Resume at the last timestamp, inclusive, as the
 * official time-range pagination contract requires. A complete pass rewinds so
 * delayed indexing can never permanently hide an earlier credit. */
export async function scanPerpsCredit(address: string, hashes: string[], minimum: string, earliest: number, endTime: number, startTime = earliest): Promise<{ credit?: { hash: string; amount: string; time: number }; nextStartTime: number }> {
  let cursor = Math.max(earliest, Math.min(startTime, endTime));
  for (let page = 0; page < 4; page++) {
    const ledger = await getLedger(address, cursor, endTime);
    if (ledger.some(entry => entry.time < cursor || entry.time > endTime)) throw new UpstreamError('INVALID_LEDGER_RANGE', 'Hyperliquid 账本返回超出查询范围，等待重新核验。');
    const credit = findPerpsCredit(ledger, address, hashes, minimum, earliest);
    if (credit) return { credit, nextStartTime: cursor };
    if (ledger.length < 500) return { nextStartTime: earliest };
    const lastTime = Math.max(...ledger.map(entry => entry.time));
    // Never skip an unpageable timestamp: that could conceal the target event.
    if (lastTime <= cursor) return { nextStartTime: cursor };
    cursor = lastTime;
  }
  return { nextStartTime: cursor };
}

/** Match an exact provider fill hash and a recipient's positive DEFAULT-PERPS USDC ledger event. Never infer credit from a balance delta. */
export function findPerpsCredit(ledger: Ledger, recipient: string, destinationHashes: string[], minimum: string, earliest: number): { hash: string; amount: string; time: number } | undefined {
  const hashes = new Set(destinationHashes.map(h => h.toLowerCase()));
  for (const entry of ledger) {
    if (entry.time < earliest || !hashes.has(entry.hash.toLowerCase())) continue;
    const delta = entry.delta;
    if (typeof delta.destination !== 'string' || delta.destination.toLowerCase() !== recipient.toLowerCase()) continue;
    let amount: unknown;
    if (delta.type === 'internalTransfer') amount = delta.usdc;
    else if (delta.type === 'send' && delta.destinationDex === '' && delta.token === 'USDC') amount = delta.amount;
    else continue; // Unknown credit classes remain verifying_credit; never guess spot/perps semantics.
    if (typeof amount !== 'string' || !/^\d+(\.\d{1,8})?$/.test(amount)) continue;
    if (parseUnits(amount, 8) < parseUnits(minimum, 8) || parseUnits(amount, 8) <= 0n) continue;
    return { hash: entry.hash, amount, time: entry.time };
  }
  return undefined;
}
