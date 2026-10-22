import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FunnelConfig, FunnelContext, FunnelEventName } from '../shared/funnel.js';
import { validFunnelClientEvent, validFunnelContext } from '../shared/funnel.js';
import type { Order } from '../shared/types.js';
import { REVIEWED_EVM_SOURCES } from '../shared/route-registry.js';
import { decimalUnits } from './security.js';

export interface FunnelRecorderConfig extends FunnelConfig { posthog?: { apiKey: string; host: string } }
const HOSTS = ['https://us.i.posthog.com', 'https://eu.i.posthog.com'];
export function funnelConfiguration(enabled?: string, posthogEnabled?: string, apiKey?: string, host?: string): FunnelRecorderConfig | undefined {
  if (enabled !== 'true') return;
  const normalized = host?.replace(/\/$/, '');
  if (posthogEnabled !== 'true') return { enabled: true };
  if (!apiKey || !/^[A-Za-z0-9_-]{10,256}$/.test(apiKey) || !normalized || !HOSTS.includes(normalized)) {
    throw new Error('Invalid PostHog configuration. Check the project key and supported ingestion host.');
  }
  return { enabled: true, posthog: { apiKey, host: normalized } };
}
export const FUNNEL_LIMITS = { sessions: 10_000, attempts: 50_000, orders: 50_000, events: 100_000,
  retentionDays: 30, batchSize: 50, maxAttempts: 5, requestTimeoutMs: 3_000 } as const;
const ROUTES = new Set([...REVIEWED_EVM_SOURCES.map(item => item.route.id), 'tron-usdt-hypercore', 'solana-usdc-hypercore']);
const routeLabel = (value: string): string => ROUTES.has(value) ? value : 'other';
const validTime = (value: string): boolean => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
type Authority = 'client' | 'authenticated_client' | 'server';
interface SessionRow { session_id: string; lang: 'zh' | 'en' }
interface AttemptRow extends SessionRow { attempt_id: string; route_id: string; quote_id: string | null; outcome: string | null }
interface EventRow extends SessionRow {
  uuid: string; event: FunnelEventName; event_at: string; authority: Authority;
  route_id: string | null; wallet_type: string | null; attempts: number;
}
interface Options { now?: () => number; fetch?: typeof fetch; diagnostic?: () => void }

/** Separate disposable database; all collector calls contain their own failure boundary.
 * No request objects, IPs, user agents, addresses, hashes, amounts or exception messages are accepted.
 */
export class FunnelRecorder {
  private db?: DatabaseSync;
  private healthy = true;
  private warned = false;
  private lastPruned = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private stopped = false;
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly config: FunnelRecorderConfig;
  constructor(path: string, config: FunnelRecorderConfig, private readonly options: Options = {}) {
    this.now = options.now ?? Date.now; this.fetcher = options.fetch ?? fetch;
    this.config = funnelConfiguration(config.enabled ? 'true' : undefined, config.posthog ? 'true' : undefined,
      config.posthog?.apiKey, config.posthog?.host) ?? { enabled: true };
    if (config.enabled !== true) { this.healthy = false; return; }
    this.safely(() => {
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(path);
      this.db.exec(`PRAGMA busy_timeout=10; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS funnel_sessions (
          session_id TEXT PRIMARY KEY, lang TEXT NOT NULL, first_seen_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS funnel_attempts (
          attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES funnel_sessions(session_id) ON DELETE CASCADE,
          route_id TEXT NOT NULL, requested_at TEXT NOT NULL, outcome TEXT, quote_id TEXT UNIQUE
        );
        CREATE TABLE IF NOT EXISTS funnel_orders (
          order_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES funnel_attempts(quote_id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS funnel_events (
          event_key TEXT PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES funnel_sessions(session_id) ON DELETE CASCADE,
          event TEXT NOT NULL, event_at TEXT NOT NULL, authority TEXT NOT NULL,
          route_id TEXT, wallet_type TEXT, quote_id TEXT, order_id TEXT,
          delivery TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS funnel_delivery ON funnel_events(delivery, next_attempt_at);
        CREATE INDEX IF NOT EXISTS funnel_event_time ON funnel_events(event_at);
        CREATE INDEX IF NOT EXISTS funnel_session_cohort ON funnel_sessions(first_seen_at);
        CREATE TABLE IF NOT EXISTS funnel_counters (name TEXT PRIMARY KEY, count INTEGER NOT NULL);
      `);
      this.prune();
    });
  }
  publicConfig(): FunnelConfig | undefined { return this.healthy && this.db && !this.stopped ? { enabled: true } : undefined; }
  private safely(action: () => void): boolean {
    if (!this.healthy || this.stopped) return false;
    try { action(); return true; }
    catch {
      this.healthy = false;
      if (!this.warned) {
        this.warned = true;
        try { (this.options.diagnostic ?? (() => console.warn(JSON.stringify({ event: 'funnel_unavailable' }))))(); } catch { /* Never log raw errors. */ }
      }
      return false;
    }
  }
  private transaction(action: () => void): boolean {
    return this.safely(() => {
      this.db!.exec('BEGIN IMMEDIATE');
      try { this.prune(); action(); this.db!.exec('COMMIT'); }
      catch (error) { try { this.db!.exec('ROLLBACK'); } catch { /* Preserve original failure. */ } throw error; }
    });
  }
  private prune(): void {
    const now = this.now();
    if (now - this.lastPruned < 60 * 60_000) return;
    const cutoff = new Date(now - FUNNEL_LIMITS.retentionDays * 86_400_000).toISOString();
    this.db!.prepare('DELETE FROM funnel_sessions WHERE first_seen_at < ?').run(cutoff);
    this.db!.prepare('DELETE FROM funnel_events WHERE event_at < ?').run(cutoff);
    this.lastPruned = now;
  }
  private counter(name: string, count = 1): void {
    this.db!.prepare('INSERT INTO funnel_counters(name,count) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET count=count+excluded.count').run(name, count);
  }
  private capacity(table: 'sessions' | 'attempts' | 'orders' | 'events'): boolean {
    if ((this.db!.prepare(`SELECT COUNT(*) AS n FROM funnel_${table}`).get() as { n: number }).n < FUNNEL_LIMITS[table]) return false;
    this.counter(`capacity_dropped_${table}`); return true;
  }
  private session(context: FunnelContext, at: string): boolean {
    const existing = this.db!.prepare('SELECT lang FROM funnel_sessions WHERE session_id=?').get(context.sessionId) as { lang: string } | undefined;
    if (existing) return existing.lang === context.lang;
    if (this.capacity('sessions')) return false;
    this.db!.prepare('INSERT INTO funnel_sessions(session_id,lang,first_seen_at) VALUES (?,?,?)').run(context.sessionId, context.lang, at);
    return true;
  }
  private event(key: string, context: Pick<FunnelContext, 'sessionId'>, name: FunnelEventName, at: string, authority: Authority,
    routeId?: string, walletType?: string, quoteId?: string, orderId?: string): void {
    if (!validTime(at) || this.db!.prepare('SELECT 1 FROM funnel_events WHERE event_key=?').get(key)) return;
    if (this.capacity('events')) return;
    this.db!.prepare(`INSERT INTO funnel_events(event_key,uuid,session_id,event,event_at,authority,route_id,wallet_type,quote_id,order_id,delivery)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(key, randomUUID(), context.sessionId, name, at, authority,
        routeId ? routeLabel(routeId) : null, walletType ?? null, quoteId ?? null, orderId ?? null, this.config.posthog ? 'pending' : 'local_only');
  }
  client(value: unknown, at: string): boolean {
    const input = validFunnelClientEvent(value);
    if (!input || !validTime(at)) return false;
    let accepted = false;
    return this.transaction(() => {
      if (!this.session(input, at)) return;
      const key = input.event === 'landing' ? `landing:${input.sessionId}` : `client:${input.sessionId}:${input.eventId}`;
      this.event(key, input, input.event, at, 'client', undefined, input.walletType);
      accepted = true;
    }) && accepted;
  }
  private attempt(context: FunnelContext, routeId: string, at: string): AttemptRow | undefined {
    if (!this.session(context, at)) return;
    const read = () => this.db!.prepare(`SELECT a.*,s.lang FROM funnel_attempts a JOIN funnel_sessions s USING(session_id)
      WHERE attempt_id=?`).get(context.attemptId) as AttemptRow | undefined;
    let row = read();
    if (!row) {
      if (this.capacity('attempts')) return;
      this.db!.prepare('INSERT INTO funnel_attempts(attempt_id,session_id,route_id,requested_at) VALUES (?,?,?,?)')
        .run(context.attemptId, context.sessionId, routeLabel(routeId), at);
      row = read();
    }
    return row?.session_id === context.sessionId && row.route_id === routeLabel(routeId) ? row : undefined;
  }
  quoteStarted(value: unknown, routeId: string, at: string): void {
    const context = validFunnelContext(value);
    if (!context || !validTime(at)) return;
    this.transaction(() => {
      if (this.attempt(context, routeId, at)) this.event(`quote_requested:${context.attemptId}`, context, 'quote_requested', at, 'server', routeId);
    });
  }
  quoteSucceeded(quoteId: string, routeId: string, value: unknown, at: string): void {
    const context = validFunnelContext(value);
    if (!context || !validTime(at)) return;
    this.transaction(() => {
      const row = this.attempt(context, routeId, at);
      if (!row || (row.outcome && (row.outcome !== 'succeeded' || row.quote_id !== quoteId))) return;
      this.db!.prepare('UPDATE funnel_attempts SET outcome=?, quote_id=? WHERE attempt_id=?').run('succeeded', quoteId, context.attemptId);
      this.event(`quote_succeeded:${quoteId}`, context, 'quote_succeeded', at, 'server', routeId, undefined, quoteId);
    });
  }
  quoteFailed(value: unknown, routeId: string, at: string): void {
    const context = validFunnelContext(value);
    if (!context || !validTime(at)) return;
    this.transaction(() => {
      const row = this.attempt(context, routeId, at);
      if (!row || (row.outcome && row.outcome !== 'failed')) return;
      this.db!.prepare('UPDATE funnel_attempts SET outcome=? WHERE attempt_id=?').run('failed', context.attemptId);
      this.event(`quote_failed:${context.attemptId}`, context, 'quote_failed', at, 'server', routeId);
    });
  }
  /** Invoked after committed state only. Never promotes a client declaration to on-chain success. */
  order(order: Order): void {
    this.transaction(() => {
      const row = this.db!.prepare(`SELECT a.*,s.lang FROM funnel_attempts a JOIN funnel_sessions s USING(session_id)
        WHERE quote_id=?`).get(order.quote.id) as AttemptRow | undefined;
      if (!row) return; // No retroactive attribution of legacy or disabled sessions.
      if (!this.db!.prepare('SELECT 1 FROM funnel_orders WHERE order_id=?').get(order.id)) {
        if (this.capacity('orders')) return;
        this.db!.prepare('INSERT OR IGNORE INTO funnel_orders(order_id,quote_id,created_at) VALUES (?,?,?)').run(order.id, order.quote.id, order.createdAt);
      }
      const context = { sessionId: row.session_id };
      const record = (name: FunnelEventName, at: string | undefined, authority: Authority = 'server') => {
        if (at) this.event(`order:${order.id}:${name}`, context, name, at, authority, row.route_id, undefined, order.quote.id, order.id);
      };
      record('order_created', order.createdAt);
      record('signing_started', order.clientStages?.signing?.receivedAt, 'authenticated_client');
      record('broadcast_observed', order.clientStages?.broadcast?.receivedAt, 'authenticated_client');
      const sourceAt = order.sourceTxHash
        ? order.timings?.sourceConfirmedObservedAt ?? order.events.find(event => ['bridging', 'verifying_credit', 'completed'].includes(event.status))?.at : undefined;
      record('source_confirmed', sourceAt);
      const completedAt = order.status === 'completed' && sourceAt && order.destinationTxHash
        && order.creditedAmount && decimalUnits(order.creditedAmount, 8) > 0n
        && decimalUnits(order.creditedAmount, 8) >= decimalUnits(order.quote.minReceive, 8)
        && order.evidence?.some(item => item.type === 'hypercore_credit'
          && item.reference.toLowerCase() === `${order.quote.recipient}:${order.destinationTxHash}`.toLowerCase())
        ? order.timings?.creditVerifiedObservedAt ?? order.events.find(event => event.status === 'completed')?.at : undefined;
      record('credit_verified', completedAt);
    });
  }
  startExport(intervalMs = 10_000): void {
    if (this.timer || !this.config.posthog || !this.publicConfig()) return;
    this.timer = setInterval(() => { void this.flush(); }, Math.max(1_000, intervalMs));
    this.timer.unref();
  }
  /** One bounded batch, never called on the funding critical path. Stable UUID on every retry. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.config.posthog || !this.publicConfig()) return Promise.resolve();
    this.flushing = this.sendBatch().catch(() => {}).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  private async sendBatch(): Promise<void> {
    let rows: EventRow[] = [];
    const reserved = this.transaction(() => {
      // Persist attempts before network I/O so restarts cannot reset the retry budget.
      const expiredDrops = this.db!.prepare(`UPDATE funnel_events SET delivery='dropped'
        WHERE delivery='sending' AND next_attempt_at<=? AND attempts>=?`).run(this.now(), FUNNEL_LIMITS.maxAttempts);
      if (expiredDrops.changes) this.counter('export_dropped', Number(expiredDrops.changes));
      this.db!.prepare(`UPDATE funnel_events SET delivery='pending'
        WHERE delivery='sending' AND next_attempt_at<=? AND attempts<?`).run(this.now(), FUNNEL_LIMITS.maxAttempts);
      rows = this.db!.prepare(`SELECT e.*,s.lang FROM funnel_events e JOIN funnel_sessions s USING(session_id)
        WHERE delivery='pending' AND next_attempt_at <= ? AND attempts < ? ORDER BY event_at,uuid LIMIT ?`)
        .all(this.now(), FUNNEL_LIMITS.maxAttempts, FUNNEL_LIMITS.batchSize) as unknown as EventRow[];
      for (const row of rows) {
        row.attempts++;
        this.db!.prepare(`UPDATE funnel_events SET delivery='sending',attempts=?,next_attempt_at=? WHERE uuid=? AND delivery='pending'`)
          .run(row.attempts, this.now() + FUNNEL_LIMITS.requestTimeoutMs + 1_000, row.uuid);
      }
    });
    if (!reserved || !rows.length || !this.healthy || !this.config.posthog || this.stopped) return;
    // Explicit property construction is the outbound boundary; never serialize rows or Orders.
    const payload = {
      api_key: this.config.posthog.apiKey,
      batch: rows.map(row => ({ uuid: row.uuid, event: `dock_${row.event}`, timestamp: row.event_at,
        properties: { distinct_id: row.session_id, $process_person_profile: false, $geoip_disable: true,
          authority: row.authority, lang: row.lang, ...(row.route_id ? { route: row.route_id } : {}),
          ...(row.wallet_type ? { wallet_type: row.wallet_type } : {}) } })),
    };
    let delivered = false;
    let permanent = false;
    try {
      const response = await this.fetcher(`${this.config.posthog.host}/batch/`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(FUNNEL_LIMITS.requestTimeoutMs),
      });
      delivered = response.ok;
      permanent = response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status);
      // Discard the body; it may echo credentials or event metadata and is not a diagnostic.
      try { await response.body?.cancel(); } catch { /* Nothing sensitive is logged. */ }
    } catch { /* Bounded retry below; no exception escapes to funds. */ }
    this.transaction(() => {
      for (const row of rows) {
        const attempts = row.attempts;
        const delivery = delivered ? 'delivered' : permanent || attempts >= FUNNEL_LIMITS.maxAttempts ? 'dropped' : 'pending';
        this.db!.prepare(`UPDATE funnel_events SET delivery=?,next_attempt_at=? WHERE uuid=? AND delivery='sending' AND attempts=?`)
          .run(delivery, this.now() + Math.min(300_000, 5_000 * 2 ** (attempts - 1)), row.uuid, attempts);
        if (delivery === 'dropped') this.counter('export_dropped');
      }
    });
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Finish only the already-running bounded request; shutdown never starts a new export.
    await this.flushing;
    this.stopped = true;
    try { this.db?.close(); } catch { /* Funding shutdown stays independent. */ }
    this.db = undefined; this.healthy = false;
  }
}
