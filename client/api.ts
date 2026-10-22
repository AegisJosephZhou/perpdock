import type { Account, AppConfig, Order, Quote, QuoteRequest } from '../shared/types.js';
import { getQuoteAttribution } from './attribution.js';

export class ApiError extends Error {
  constructor(message: string, public code: string, public requestId?: string) { super(message); }
}

async function request<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (body as { error?: { message?: string; code?: string; requestId?: string } } | null)?.error;
    throw new ApiError(error?.message || `请求未完成（HTTP ${response.status}）`, error?.code || 'HTTP_ERROR', error?.requestId);
  }
  if (!body) throw new ApiError('服务暂时没有返回可读取的数据，请重试。', 'INVALID_RESPONSE');
  return body as T;
}

export const api = {
  config: () => request<AppConfig>('/config'),
  quote: (input: QuoteRequest) => {
    const attribution = getQuoteAttribution();
    return request<Quote>('/quotes', { method: 'POST', body: JSON.stringify({ ...input, ...(attribution ? { attribution } : {}) }) });
  },
  createOrder: (quoteId: string, key: string) => request<{ order: Order; accessToken: string }>('/orders', { method: 'POST', body: JSON.stringify({ quoteId }), headers: { 'Idempotency-Key': key } }),
  order: (id: string, token: string) => request<Order>(`/orders/${encodeURIComponent(id)}`, {}, token),
  report: (id: string, token: string, txHash: string) => request<Order>(`/orders/${encodeURIComponent(id)}/transaction`, { method: 'POST', body: JSON.stringify({ txHash }) }, token),
  refresh: (id: string, token: string) => request<Order>(`/orders/${encodeURIComponent(id)}/refresh`, { method: 'POST' }, token),
  account: (address: string) => request<Account>(`/account/${encodeURIComponent(address)}`),
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}${error.requestId ? `（请求编号：${error.requestId}）` : ''}`;
  if (error instanceof Error) {
    if (/abort|timeout/i.test(error.name)) return '请求超时。若已在钱包签名，请先核对交易记录，不要再次付款。';
    if (/fetch|network/i.test(error.message)) return '暂时无法连接服务。已签名的交易请保留，连接恢复后可继续上报。';
    return error.message;
  }
  return '操作未完成，请稍后重试。';
}

export interface SavedOrder {
  id: string;
  accessToken: string;
  createdAt: string;
  submission?: { state: 'signing' | 'submitted' | 'unknown'; txHash?: string };
}
export const STORAGE_KEY = 'hl-funding.orders.v1';
export const SUBMISSION_PREFIX = 'hl-funding.submission.v1.';
function validatedSubmission(value: unknown): SavedOrder['submission'] {
  if (!value || typeof value !== 'object') throw new Error('本机付款记录无法读取，请先核对钱包交易，不要重复付款。');
  const item = value as SavedOrder['submission'];
  if (!item || !['signing', 'submitted', 'unknown'].includes(item.state) || (item.txHash !== undefined && typeof item.txHash !== 'string')) throw new Error('本机付款记录无法读取，请先核对钱包交易，不要重复付款。');
  return item;
}
function readSubmission(id: string): SavedOrder['submission'] {
  const raw = localStorage.getItem(`${SUBMISSION_PREFIX}${id}`);
  if (raw === null) return;
  return validatedSubmission(JSON.parse(raw));
}
/** Strict safety read: invalid, inaccessible and orphaned state is never “no payment”. */
export function readLocalPaymentState(): { orders: SavedOrder[]; orphanedIds: string[] } {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) throw new Error('invalid order list');
    const seen = new Set<string>();
    const orders = raw.map((entry): SavedOrder => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || typeof entry.accessToken !== 'string' || !entry.accessToken || typeof entry.createdAt !== 'string' || seen.has(entry.id)) throw new Error('invalid saved order');
      seen.add(entry.id);
      const inline = entry.submission === undefined ? undefined : validatedSubmission(entry.submission);
      return { id: entry.id, accessToken: entry.accessToken, createdAt: entry.createdAt, submission: readSubmission(entry.id) || inline };
    });
    const orphanedIds: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(SUBMISSION_PREFIX)) continue;
      const id = key.slice(SUBMISSION_PREFIX.length);
      if (!id || !readSubmission(id)) throw new Error('invalid payment marker');
      if (!seen.has(id)) orphanedIds.push(id);
    }
    return { orders, orphanedIds };
  } catch {
    throw new Error('本机订单或付款恢复记录无法完整读取，已阻止新的付款。请先核对原交易，不要清除浏览器数据。');
  }
}
export function savedOrderForPayment(id: string): SavedOrder | undefined {
  return readLocalPaymentState().orders.find(entry => entry.id === id);
}
function retainRecentAndPayments(entries: SavedOrder[]): SavedOrder[] {
  let unsigned = 0;
  return entries.filter(entry => !!entry.submission || unsigned++ < 20);
}
export async function withOrderPaymentLock<T>(id: string, action: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('当前浏览器无法安全锁定付款，请使用支持 Web Locks 的新版浏览器并通过 HTTPS 打开。');
  return navigator.locks.request(`hl-funding.payment.${id}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('本订单正在另一个标签页处理，请返回该页面，勿重复付款。');
    return action();
  });
}
export function loadSavedOrders(): SavedOrder[] {
  try { return retainRecentAndPayments(readLocalPaymentState().orders); }
  catch { return []; } // Display only. Every money entry point uses the strict read above.
}
export function persistSavedOrder(entry: SavedOrder): SavedOrder[] {
  const entries = retainRecentAndPayments([entry, ...readLocalPaymentState().orders.filter((item) => item.id !== entry.id)]);
  // Failure is deliberately not swallowed: signing must stop if recovery data cannot be retained.
  // Keep a per-order marker, independent of the recent-order list, so another tab
  // cannot overwrite this payment state while saving a different order.
  if (entry.submission) localStorage.setItem(`${SUBMISSION_PREFIX}${entry.id}`, JSON.stringify(entry.submission));
  else localStorage.removeItem(`${SUBMISSION_PREFIX}${entry.id}`);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  return entries;
}
