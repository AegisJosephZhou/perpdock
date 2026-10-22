import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AttributionConfig, AttributionContext } from '../shared/attribution.js';
import { validAttribution, validCampaignList } from '../shared/attribution.js';
import type { Order } from '../shared/types.js';
import { decimalUnits } from './security.js';

/** Invalid analytics configuration disables collection, without preventing funding startup. */
export function attributionConfiguration(enabled?: string, campaignList?: string): AttributionConfig | undefined {
  if (enabled !== 'true') return undefined;
  const campaigns = campaignList?.split(',').map(value => value.trim());
  return validCampaignList(campaigns) ? { enabled: true, campaigns } : undefined;
}

type SessionRow = AttributionContext;
export const ATTRIBUTION_LIMITS = { sessions: 10_000, quotes: 50_000, orders: 50_000, retentionDays: 30 } as const;

/** Disposable first-party analytics. No financial database writes, credentials, or chain calls. */
export class AttributionRecorder {
  private db?: DatabaseSync;
  private healthy = true;
  private warned = false;
  private lastPruned = 0;
  private readonly config: AttributionConfig;
  constructor(path: string, config: AttributionConfig, private readonly diagnostic: () => void = () => {
    console.warn(JSON.stringify({ event: 'attribution_unavailable' }));
  }) {
    this.config = { enabled: true, campaigns: [...config.campaigns] };
    if (!validCampaignList(config.campaigns)) { this.healthy = false; return; }
    this.safely(() => {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path);
      this.db.exec(`
        PRAGMA busy_timeout=25;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS attribution_sessions (
          session_id TEXT PRIMARY KEY, campaign TEXT NOT NULL, source TEXT NOT NULL,
          medium TEXT NOT NULL, lang TEXT NOT NULL, first_seen_at TEXT NOT NULL, landing_at TEXT
        );
        CREATE TABLE IF NOT EXISTS attribution_quotes (
          quote_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES attribution_sessions(session_id) ON DELETE CASCADE,
          route_id TEXT NOT NULL, quoted_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS attribution_orders (
          order_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES attribution_quotes(quote_id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, source_confirmed_at TEXT, completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS attribution_sessions_cohort ON attribution_sessions(first_seen_at);
        CREATE TABLE IF NOT EXISTS attribution_counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL);
      `);
      this.prune();
    });
  }
  publicConfig(): AttributionConfig | undefined {
    return this.healthy && this.db ? { enabled: true, campaigns: [...this.config.campaigns] } : undefined;
  }
  private safely(action: () => void): boolean {
    if (!this.healthy) return false;
    try { action(); return true; }
    catch {
      this.healthy = false;
      if (!this.warned) {
        this.warned = true;
        try { this.diagnostic(); } catch { /* Diagnostics must not affect funds. */ }
      }
      return false;
    }
  }
  private transaction(action: () => void): boolean {
    return this.safely(() => {
      this.db!.exec('BEGIN IMMEDIATE');
      try { this.prune(); action(); this.db!.exec('COMMIT'); }
      catch (error) { try { this.db!.exec('ROLLBACK'); } catch { /* Preserve failure. */ } throw error; }
    });
  }
  private prune(): void {
    const now = Date.now();
    if (now - this.lastPruned < 24 * 60 * 60_000) return;
    this.db!.prepare('DELETE FROM attribution_sessions WHERE first_seen_at < ?')
      .run(new Date(now - ATTRIBUTION_LIMITS.retentionDays * 24 * 60 * 60_000).toISOString());
    this.lastPruned = now;
  }
  private dropped(name: 'sessions' | 'quotes' | 'orders'): void {
    this.db!.prepare(`INSERT INTO attribution_counters (name, count) VALUES (?, 1)
      ON CONFLICT(name) DO UPDATE SET count=count+1`).run(`capacity_dropped_${name}`);
  }
  private atCapacity(table: 'sessions' | 'quotes' | 'orders'): boolean {
    // Table name is an internal fixed union, never request input.
    const count = (this.db!.prepare(`SELECT COUNT(*) AS count FROM attribution_${table}`).get() as { count: number }).count;
    if (count < ATTRIBUTION_LIMITS[table]) return false;
    this.dropped(table); return true;
  }
  private session(context: AttributionContext, at: string, landing: boolean): boolean {
    if (!this.db!.prepare('SELECT 1 FROM attribution_sessions WHERE session_id=?').get(context.sessionId)
      && this.atCapacity('sessions')) return false;
    this.db!.prepare(`INSERT OR IGNORE INTO attribution_sessions
      (session_id, campaign, source, medium, lang, first_seen_at, landing_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(context.sessionId, context.campaign, context.source, context.medium, context.lang, at, landing ? at : null);
    const existing = this.db!.prepare(`SELECT session_id AS sessionId, campaign, source, medium, lang
      FROM attribution_sessions WHERE session_id=?`).get(context.sessionId) as SessionRow | undefined;
    if (!existing || existing.campaign !== context.campaign || existing.source !== context.source
      || existing.medium !== context.medium || existing.lang !== context.lang) return false;
    if (landing) this.db!.prepare('UPDATE attribution_sessions SET landing_at=COALESCE(landing_at, ?) WHERE session_id=?')
      .run(at, context.sessionId);
    return true;
  }
  landing(value: unknown, at: string): boolean {
    const context = validAttribution(value, this.config.campaigns);
    if (!context) return false;
    let accepted = false;
    return this.transaction(() => { accepted = this.session(context, at, true); }) && accepted;
  }
  quote(quoteId: string, routeId: string, value: unknown, at: string): void {
    const context = validAttribution(value, this.config.campaigns);
    if (!context) return;
    this.transaction(() => {
      if (!this.session(context, at, false)) return;
      if (!this.db!.prepare('SELECT 1 FROM attribution_quotes WHERE quote_id=?').get(quoteId)
        && this.atCapacity('quotes')) return;
      this.db!.prepare(`INSERT OR IGNORE INTO attribution_quotes (quote_id, session_id, route_id, quoted_at)
        VALUES (?, ?, ?, ?)`).run(quoteId, context.sessionId, routeId, at);
    });
  }
  /** Called only after the authoritative order state commits. Client events never reach this method. */
  order(order: Order): void {
    this.transaction(() => {
      if (!this.db!.prepare('SELECT 1 FROM attribution_quotes WHERE quote_id=?').get(order.quote.id)) return;
      if (!this.db!.prepare('SELECT 1 FROM attribution_orders WHERE order_id=?').get(order.id)
        && this.atCapacity('orders')) return;
      this.db!.prepare(`INSERT OR IGNORE INTO attribution_orders (order_id, quote_id, created_at)
        SELECT ?, quote_id, ? FROM attribution_quotes WHERE quote_id=?`).run(order.id, order.createdAt, order.quote.id);
      const sourceAt = order.sourceTxHash
        ? order.events.find(event => ['bridging', 'verifying_credit', 'completed'].includes(event.status))?.at : undefined;
      if (sourceAt) this.db!.prepare(`UPDATE attribution_orders
        SET source_confirmed_at=COALESCE(source_confirmed_at, ?) WHERE order_id=?`).run(sourceAt, order.id);
      // Defensive check of the same completion evidence already enforced by OrderService.
      const completedAt = order.status === 'completed' && sourceAt && order.destinationTxHash
        && order.creditedAmount && decimalUnits(order.creditedAmount, 8) > 0n
        && decimalUnits(order.creditedAmount, 8) >= decimalUnits(order.quote.minReceive, 8)
        && order.evidence?.some(item => item.type === 'hypercore_credit'
          && item.reference.toLowerCase() === `${order.quote.recipient}:${order.destinationTxHash}`.toLowerCase())
        ? order.events.find(event => event.status === 'completed')?.at : undefined;
      if (completedAt) this.db!.prepare('UPDATE attribution_orders SET completed_at=COALESCE(completed_at, ?) WHERE order_id=?')
        .run(completedAt, order.id);
    });
  }
  close(): void {
    try { this.db?.close(); } catch { /* Funding shutdown must remain independent. */ }
    this.db = undefined; this.healthy = false;
  }
}
