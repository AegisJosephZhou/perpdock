import type { AppConfig, Evidence, Order, OrderStatus, ProviderAdapter, Quote, QuoteRequest, StoredQuote, TrackingCheck, TrackingUpdate } from '../shared/types.js';
import { AppError, decimalUnits, hashSecret, newId, normalizeTxHash, orderToken, verifyToken } from './security.js';
import { Store } from './store.js';
import type { AttributionRecorder } from './attribution.js';

export interface ServiceOptions {
  tokenSecret: string; appName?: string; minAmount?: string; maxAmount?: string;
  paused?: () => boolean; now?: () => number;
  attribution?: AttributionRecorder;
}
const stages: Partial<Record<OrderStatus, number>> = { awaiting_signature: 0, source_pending: 1, bridging: 2, verifying_credit: 3, completed: 4 };
const publicQuote = ({ providerData: _private, ...quote }: StoredQuote): Quote => quote;

export class OrderService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private activeRefreshes = new Map<string, Promise<Order>>();

  constructor(readonly store: Store, readonly provider: ProviderAdapter, readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.store.assertTokenKey(hashSecret(options.tokenSecret));
  }
  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const promise = previous.catch(() => undefined).then(fn);
    this.locks.set(id, promise);
    void promise.then(() => { if (this.locks.get(id) === promise) this.locks.delete(id); },
      () => { if (this.locks.get(id) === promise) this.locks.delete(id); });
    return promise;
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private trackingCheck(order: Order, result: TrackingCheck['result']): TrackingCheck {
    const attemptedAt = this.timestamp();
    const succeededAt = result === 'ok' ? attemptedAt : order.trackingCheck?.succeededAt;
    return { attemptedAt, ...(succeededAt ? { succeededAt } : {}), result };
  }
  private assertOpen(): void {
    if (this.options.paused?.()) throw new AppError('FUNDING_PAUSED', '新入金订单暂时暂停；已有订单仍可查询和跟踪。', 503);
  }
  private token(id: string): string { return orderToken(this.options.tokenSecret, id); }
  private load(id: string): Order {
    const order = this.store.getOrder(id)?.order;
    if (!order) throw new AppError('ORDER_NOT_FOUND', '订单不存在或访问令牌无效。', 404);
    return order;
  }
  authorize(id: string, token: string): Order {
    const row = this.store.getOrder(id);
    // Do a constant-time hash comparison even for unknown IDs.
    const valid = verifyToken(token, row?.tokenHash ?? '0'.repeat(64));
    if (!row || !valid) throw new AppError('ORDER_NOT_FOUND', '订单不存在或访问令牌无效。', 404);
    return row.order;
  }
  async config(): Promise<AppConfig> {
    const attribution = this.options.attribution?.publicConfig();
    return { appName: this.options.appName ?? 'HL Funding', network: 'mainnet', routes: await this.provider.getRoutes(),
      limits: { minAmount: this.options.minAmount ?? '10', maxAmount: this.options.maxAmount ?? '1000' }, paused: this.options.paused?.() ?? false,
      ...(attribution ? { attribution } : {}) };
  }
  recordLanding(context: unknown): boolean {
    return this.options.attribution?.landing(context, this.timestamp()) ?? false;
  }
  async quote(input: QuoteRequest, attribution?: unknown): Promise<Quote> {
    this.assertOpen();
    const config = await this.config();
    const route = config.routes.find(candidate => candidate.id === input.routeId);
    if (!route || !route.available) throw new AppError('ROUTE_UNAVAILABLE', route?.reason ?? '该入金路线当前不可用。', 503);
    const units = decimalUnits(input.amount, route.decimals);
    if (units < decimalUnits(config.limits.minAmount, route.decimals) || units > decimalUnits(config.limits.maxAmount, route.decimals)) {
      throw new AppError('AMOUNT_OUT_OF_RANGE', `入金金额需在 ${config.limits.minAmount} 至 ${config.limits.maxAmount} ${route.symbol} 之间。`);
    }
    if (route.walletType === 'evm' ? !/^0x[\da-fA-F]{40}$/.test(input.sourceAddress) : !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(input.sourceAddress)) {
      throw new AppError('INVALID_SOURCE_ADDRESS', '来源钱包地址与网络不符。');
    }
    if (!/^0x[\da-fA-F]{40}$/.test(input.recipient) || /^0x0{40}$/i.test(input.recipient)) {
      throw new AppError('INVALID_RECIPIENT', '请输入用户控制的非零 EVM 收款地址。');
    }
    const draft = await this.provider.getQuote(input);
    const sameAddress = (left: string, right: string): boolean => route.walletType === 'evm' ? left.toLowerCase() === right.toLowerCase() : left === right;
    const expiry = Date.parse(draft.expiresAt);
    if (draft.routeId !== input.routeId || !sameAddress(draft.sourceAddress, input.sourceAddress) || draft.recipient.toLowerCase() !== input.recipient.toLowerCase()
      || decimalUnits(draft.amount, route.decimals) !== units || draft.amountBaseUnits !== units.toString()
      || !Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + 60 * 60 * 1000
      || !draft.providerData || typeof draft.providerData !== 'object') {
      throw new AppError('INVALID_PROVIDER_QUOTE', '上游报价与请求不一致或已过期，请重新报价。', 502);
    }
    // The provider must decode and validate calldata; this layer independently checks envelope and amounts.
    if (draft.transaction.kind !== route.walletType || decimalUnits(draft.minReceive, 8) <= 0n
      || decimalUnits(draft.expectedReceive, 8) < decimalUnits(draft.minReceive, 8)) {
      throw new AppError('INVALID_PROVIDER_QUOTE', '上游报价的资产金额或交易网络无效。', 502);
    }
    if (draft.transaction.kind === 'evm' && (draft.transaction.chainId !== route.sourceChainId
      || !/^0x[\da-fA-F]{40}$/.test(draft.transaction.to) || !/^0x(?:[\da-fA-F]{2})*$/.test(draft.transaction.data)
      || !/^\d{1,78}$/.test(draft.transaction.value))) {
      throw new AppError('INVALID_PROVIDER_QUOTE', '上游交易参数未通过核验。', 502);
    }
    const quote: StoredQuote = { ...draft, id: newId() };
    this.store.saveQuote(quote);
    this.options.attribution?.quote(quote.id, quote.routeId, attribution, this.timestamp());
    return publicQuote(quote);
  }
  create(quoteId: string, idempotencyKey: string): { order: Order; accessToken: string } {
    const keyHash = hashSecret(idempotencyKey);
    const previous = this.store.getIdempotent(keyHash, quoteId);
    if (previous) {
      this.options.attribution?.order(previous);
      return { order: previous, accessToken: this.token(previous.id) };
    }
    this.assertOpen();
    const quote = this.store.getQuote(quoteId);
    if (!quote) throw new AppError('QUOTE_NOT_FOUND', '报价不存在，请重新获取。', 404);
    if (Date.parse(quote.expiresAt) <= this.now()) throw new AppError('QUOTE_EXPIRED', '报价已过期，请重新获取。', 409);
    const at = this.timestamp();
    const message = '等待用户在来源钱包确认交易。';
    const order: Order = { id: newId(), createdAt: at, updatedAt: at, quote: publicQuote(quote),
      status: 'awaiting_signature', statusMessage: message, events: [{ at, status: 'awaiting_signature', message }] };
    const saved = this.store.createOrder(order, hashSecret(this.token(order.id)), keyHash);
    this.options.attribution?.order(saved);
    return { order: saved, accessToken: this.token(saved.id) };
  }
  private change(order: Order, status: OrderStatus, message: string, fields: Partial<Order> = {}): Order {
    const next: Order = { ...order, ...fields, status, statusMessage: message.slice(0, 500), updatedAt: this.timestamp() };
    if (order.status !== status || order.statusMessage !== message) {
      next.events = [...order.events, { at: next.updatedAt, status, message: next.statusMessage }];
    }
    this.store.updateOrder(next);
    this.options.attribution?.order(next);
    return next;
  }
  async get(id: string, token: string): Promise<Order> {
    this.authorize(id, token);
    return this.locked(id, async () => {
      const order = this.load(id);
      if (order.status === 'awaiting_signature' && Date.parse(order.quote.expiresAt) <= this.now()) {
        return this.change(order, 'expired', '报价已过期；如已广播交易，请提交交易哈希继续核验。');
      }
      return order;
    });
  }
  async submit(id: string, token: string, txHash: string): Promise<Order> {
    this.authorize(id, token);
    return this.locked(id, async () => {
      const order = this.load(id);
      const hash = normalizeTxHash(txHash, order.quote.transaction.kind);
      if (order.sourceTxHash) {
        if (order.sourceTxHash !== hash) throw new AppError('TRANSACTION_CONFLICT', '订单已关联其他交易，不能覆盖。', 409);
        return order;
      }
      const quote = this.store.getQuote(order.quote.id);
      if (!quote) throw new AppError('QUOTE_NOT_FOUND', '无法恢复原报价，请联系支持。', 500);
      const verification = await this.provider.verifySourceTransaction(quote, hash);
      if (!verification.valid) throw new AppError('TRANSACTION_MISMATCH', verification.reason ?? '交易与该订单不匹配。', 422);
      const next = this.change(order, verification.pending ? 'source_pending' : 'bridging',
        verification.pending ? '来源交易等待可验证的最终确认；当前尚未确认资金到账。' : '来源交易已核验，正在跟踪目标资金入账。',
        { sourceTxHash: hash, trackingCheck: this.trackingCheck(order, 'ok'),
          ...(verification.providerOrderId ? { providerOrderId: verification.providerOrderId } : {}) });
      this.store.schedulePoll(id, this.now(), 0);
      return next;
    });
  }
  async refresh(id: string, token?: string): Promise<Order> {
    if (token !== undefined) this.authorize(id, token);
    const active = this.activeRefreshes.get(id);
    if (active) return active;
    const promise = this.locked(id, () => this.refreshLocked(id));
    this.activeRefreshes.set(id, promise);
    void promise.then(() => this.activeRefreshes.delete(id), () => this.activeRefreshes.delete(id));
    return promise;
  }
  private mergeEvidence(current: Evidence[] = [], next: Evidence[] = []): Evidence[] {
    const map = new Map(current.map(evidence => [`${evidence.type}:${evidence.reference}`, evidence]));
    for (const item of next) {
      if (typeof item.type !== 'string' || typeof item.reference !== 'string' || !item.reference || item.reference.length > 1000) {
        throw new AppError('INVALID_TRACKING_EVIDENCE', '上游入账证据格式无效。', 502);
      }
      map.set(`${item.type}:${item.reference}`, item);
    }
    return [...map.values()];
  }
  private applyTracking(order: Order, update: TrackingUpdate): Order {
    if (order.status === 'completed') return order;
    if (!update || !['source_pending', 'bridging', 'verifying_credit', 'completed', 'attention'].includes(update.status)
      || typeof update.statusMessage !== 'string') throw new AppError('INVALID_TRACKING_UPDATE', '上游订单状态无效。', 502);
    const highest = Math.max(...order.events.map(event => stages[event.status] ?? 0));
    const stage = stages[update.status];
    if (stage !== undefined && stage < highest) {
      // A lower-stage response is a completed read, but cannot erase confirmed
      // facts. Replace any prior network-error message with this distinct case.
      return this.change(order, order.status, '已取得查询结果，但与已确认进度不一致；保留原记录并继续核验，请勿重复付款。');
    }
    const evidence = this.mergeEvidence(order.evidence, update.evidence);
    if (update.status === 'completed') {
      const destinationHash = update.destinationTxHash;
      const boundReference = destinationHash ? `${order.quote.recipient}:${destinationHash}`.toLowerCase() : undefined;
      if (!update.creditedAmount || decimalUnits(update.creditedAmount, 8) < decimalUnits(order.quote.minReceive, 8)
        || !destinationHash || !/^0x[\da-fA-F]{64}$/.test(destinationHash)
        || !boundReference || !evidence.some(item => item.type === 'hypercore_credit' && item.reference.toLowerCase() === boundReference)) {
        return this.change(order, 'verifying_credit', '等待可归属于本订单的 HyperCore 保证金入账证据。', { evidence });
      }
    }
    const fields: Partial<Order> = { evidence };
    if (update.destinationTxHash) fields.destinationTxHash = update.destinationTxHash;
    if (update.providerOrderId) fields.providerOrderId = update.providerOrderId;
    if (update.creditedAmount) fields.creditedAmount = update.creditedAmount;
    return this.change(order, update.status, update.statusMessage, fields);
  }
  private async refreshLocked(id: string): Promise<Order> {
    let order = this.load(id);
    if (!order.sourceTxHash || order.status === 'completed') return order;
    const storedQuote = this.store.getQuote(order.quote.id);
    if (!storedQuote) throw new AppError('QUOTE_NOT_FOUND', '无法恢复原报价，请联系支持。', 500);
    try {
      // Pending hashes are revalidated before trusting any provider destination status.
      if (!order.events.some(event => ['bridging', 'verifying_credit', 'completed'].includes(event.status))) {
        const verified = await this.provider.verifySourceTransaction(storedQuote, order.sourceTxHash);
        if (!verified.valid) {
          order = this.change(order, 'attention', '来源交易与订单不匹配，需要核查；尚未确认入金成功。',
            { trackingCheck: this.trackingCheck(order, 'ok') });
          this.store.schedulePoll(id, this.now() + 5 * 60_000, 0);
          return order;
        }
        if (verified.pending) {
          order = this.change(order, 'source_pending', '来源交易等待可验证的最终确认；当前尚未确认资金到账。',
            { trackingCheck: this.trackingCheck(order, 'ok') });
          this.store.schedulePoll(id, this.now() + 15_000, 0);
          return order;
        }
        order = this.change(order, 'bridging', '来源交易已最终核验，正在跟踪目标入账。',
          verified.providerOrderId ? { providerOrderId: verified.providerOrderId } : {});
      }
      const update = await this.provider.trackOrder({ ...order, providerData: storedQuote.providerData });
      order = this.applyTracking(order, update);
      // Persist the cursor only after the corresponding evidence/state was
      // recorded. A crash before this write merely repeats safe read queries.
      if (update.providerDataPatch !== undefined) this.store.patchQuoteProviderData(order.quote.id, update.providerDataPatch);
      // Freshness records a completed query, independently from funds progress.
      // This also persists checks when state/message otherwise remain unchanged.
      order = this.change(order, order.status, order.statusMessage, { trackingCheck: this.trackingCheck(order, 'ok') });
      this.store.schedulePoll(id, this.now() + (order.status === 'attention' ? 5 * 60_000 : 15_000), 0);
      return order;
    } catch (error) {
      const failures = this.store.pollFailures(id) + 1;
      this.store.schedulePoll(id, this.now() + Math.min(300_000, 5000 * 2 ** Math.min(failures, 6)), failures);
      // Unknown network/receipt state is not a failed transfer and never triggers payment or refund.
      const message = '暂时无法核验最新进度，系统会继续查询；请勿重复付款。';
      return this.change(order, order.status, message, { trackingCheck: this.trackingCheck(order, 'unavailable') });
    }
  }
  startPolling(intervalMs = 5000): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const orders = this.store.dueOrders(this.now());
      // Bounded concurrency; providers perform reads only.
      for (let i = 0; i < orders.length; i += 4) {
        if (this.stopped) break;
        await Promise.allSettled(orders.slice(i, i + 4).map(order => this.refresh(order.id)));
      }
    } finally { this.ticking = false; }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.locks.values()]);
  }
}
