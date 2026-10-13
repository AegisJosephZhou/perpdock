import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Order, ProviderData, StoredQuote } from '../shared/types.js';
import { AppError } from './security.js';

interface OrderRow { payload: string; token_hash: string }

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
        token_hash TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
        source_hash TEXT, next_poll_at INTEGER NOT NULL DEFAULT 0, poll_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS orders_source_hash ON orders(source_hash) WHERE source_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS orders_poll ON orders(next_poll_at, status);
      CREATE TABLE IF NOT EXISTS idempotency (
        key_hash TEXT PRIMARY KEY, quote_id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id)
      );
      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id),
        at TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  assertTokenKey(fingerprint: string): void {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get('order_token_key') as { value: string } | undefined;
    if (row && row.value !== fingerprint) throw new Error('ORDER_TOKEN_SECRET changed: existing order recovery would break. Restore the original key.');
    if (!row) this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)').run('order_token_key', fingerprint);
  }

  saveQuote(quote: StoredQuote): void {
    this.db.prepare('INSERT INTO quotes(id, payload, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(quote.id, JSON.stringify(quote), quote.expiresAt, new Date().toISOString());
  }
  getQuote(id: string): StoredQuote | undefined {
    const row = this.db.prepare('SELECT payload FROM quotes WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as StoredQuote : undefined;
  }
  patchQuoteProviderData(id: string, patch: ProviderData): void {
    // Adapter state is private JSON, not an arbitrary executable object. In
    // particular, no caller can use this patch to replace public quote fields.
    const validate = (value: unknown, depth = 0): void => {
      if (depth > 10) throw new AppError('INVALID_PROVIDER_STATE', '内部跟踪状态层级过深。', 502);
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
      if (typeof value === 'number' && Number.isFinite(value)) return;
      if (Array.isArray(value)) { for (const entry of value) validate(entry, depth + 1); return; }
      if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        for (const [key, entry] of Object.entries(value)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new AppError('INVALID_PROVIDER_STATE', '内部跟踪状态字段无效。', 502);
          validate(entry, depth + 1);
        }
        return;
      }
      throw new AppError('INVALID_PROVIDER_STATE', '内部跟踪状态必须为 JSON 数据。', 502);
    };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('INVALID_PROVIDER_STATE', '内部跟踪状态必须为对象。', 502);
    validate(patch);
    if (Buffer.byteLength(JSON.stringify(patch), 'utf8') > 65_536) throw new AppError('INVALID_PROVIDER_STATE', '内部跟踪状态超过大小限制。', 502);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const quote = this.getQuote(id);
      if (!quote) throw new AppError('QUOTE_NOT_FOUND', '无法恢复原报价，请联系支持。', 500);
      const next: StoredQuote = { ...quote, providerData: { ...quote.providerData, ...patch } };
      this.db.prepare('UPDATE quotes SET payload = ? WHERE id = ?').run(JSON.stringify(next), id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getOrder(id: string): { order: Order; tokenHash: string } | undefined {
    const row = this.db.prepare('SELECT payload, token_hash FROM orders WHERE id = ?').get(id) as unknown as OrderRow | undefined;
    return row ? { order: JSON.parse(row.payload) as Order, tokenHash: row.token_hash } : undefined;
  }
  getIdempotent(keyHash: string, quoteId: string): Order | undefined {
    const row = this.db.prepare('SELECT quote_id, order_id FROM idempotency WHERE key_hash = ?').get(keyHash) as { quote_id: string; order_id: string } | undefined;
    if (!row) return undefined;
    if (row.quote_id !== quoteId) throw new AppError('IDEMPOTENCY_CONFLICT', '幂等键已经用于另一个请求。', 409);
    return this.getOrder(row.order_id)?.order;
  }
  createOrder(order: Order, tokenHash: string, keyHash: string): Order {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.getIdempotent(keyHash, order.quote.id);
      if (existing) { this.db.exec('COMMIT'); return existing; }
      const used = this.db.prepare('SELECT id FROM orders WHERE quote_id = ?').get(order.quote.id);
      if (used) throw new AppError('QUOTE_ALREADY_USED', '该报价已创建订单，请恢复原订单。', 409);
      this.db.prepare('INSERT INTO orders(id, quote_id, token_hash, payload, status) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, order.quote.id, tokenHash, JSON.stringify(order), order.status);
      this.db.prepare('INSERT INTO idempotency(key_hash, quote_id, order_id) VALUES (?, ?, ?)').run(keyHash, order.quote.id, order.id);
      for (const event of order.events) this.db.prepare('INSERT INTO order_events(order_id, at, status, message) VALUES (?, ?, ?, ?)')
        .run(order.id, event.at, event.status, event.message);
      this.db.exec('COMMIT');
      return order;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  updateOrder(order: Order): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.getOrder(order.id)?.order;
      if (!previous) throw new AppError('ORDER_NOT_FOUND', '未找到订单。', 404);
      const chainIdentity = order.quote.transaction.kind === 'tron' ? 'tron:mainnet' : `evm:${order.quote.transaction.chainId}`;
      // A not-yet-visible hash is a claim, not ownership of a transfer. Reserving
      // it before final verification would let an unrelated pending order block
      // the real payer while the chain API is still catching up.
      const sourceVerified = order.events.some(event => ['bridging', 'verifying_credit', 'completed'].includes(event.status));
      const sourceKey = order.sourceTxHash && sourceVerified ? `${chainIdentity}:${order.sourceTxHash.toLowerCase()}` : null;
      if (sourceKey) {
        const assigned = this.db.prepare('SELECT id FROM orders WHERE source_hash = ? AND id != ?').get(sourceKey, order.id);
        if (assigned) throw new AppError('TRANSACTION_ALREADY_ASSIGNED', '该来源交易已关联其他订单。', 409);
      }
      this.db.prepare('UPDATE orders SET payload = ?, status = ?, source_hash = ? WHERE id = ?')
        .run(JSON.stringify(order), order.status, sourceKey, order.id);
      for (const event of order.events.slice(previous.events.length)) {
        this.db.prepare('INSERT INTO order_events(order_id, at, status, message) VALUES (?, ?, ?, ?)')
          .run(order.id, event.at, event.status, event.message);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  dueOrders(now: number, limit = 20): Order[] {
    return (this.db.prepare(`SELECT payload FROM orders WHERE json_extract(payload, '$.sourceTxHash') IS NOT NULL
      AND status IN ('source_pending', 'bridging', 'verifying_credit', 'attention')
      AND next_poll_at <= ? ORDER BY next_poll_at LIMIT ?`).all(now, limit) as unknown as { payload: string }[])
      .map(row => JSON.parse(row.payload) as Order);
  }
  schedulePoll(id: string, next: number, failures: number): void {
    this.db.prepare('UPDATE orders SET next_poll_at = ?, poll_failures = ? WHERE id = ?').run(next, failures, id);
  }
  pollFailures(id: string): number {
    return (this.db.prepare('SELECT poll_failures FROM orders WHERE id = ?').get(id) as { poll_failures: number } | undefined)?.poll_failures ?? 0;
  }
  close(): void { this.db.close(); }
}
