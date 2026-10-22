import { SESSION_PATTERN } from './attribution.js';

/** Deliberately independent of marketing attribution and campaign parameters. */
export interface FunnelConfig { enabled: true }
export interface FunnelContext { sessionId: string; attemptId: string; lang: 'zh' | 'en' }
export const FUNNEL_CLIENT_EVENTS = [
  'landing', 'wallet_connect_started', 'wallet_connect_succeeded', 'wallet_connect_failed',
  'quote_response_failed', 'order_create_started', 'order_create_failed',
  'signing_rejected', 'signing_failed', 'payment_reference_observed',
  'payment_outcome_unknown', 'source_report_failed',
] as const;
export type FunnelClientEventName = typeof FUNNEL_CLIENT_EVENTS[number];
export const FUNNEL_SERVER_EVENTS = [
  'quote_requested', 'quote_succeeded', 'quote_failed', 'order_created',
  'signing_started', 'broadcast_observed', 'source_confirmed', 'credit_verified',
] as const;
export type FunnelEventName = FunnelClientEventName | typeof FUNNEL_SERVER_EVENTS[number];
export interface FunnelClientEvent extends FunnelContext {
  eventId: string; event: FunnelClientEventName; walletType?: 'evm' | 'tron' | 'solana';
}
export const isFunnelId = (value: unknown): value is string => typeof value === 'string' && SESSION_PATTERN.test(value);
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function contextFields(input: Record<string, unknown>): FunnelContext | undefined {
  return isFunnelId(input.sessionId) && isFunnelId(input.attemptId) && (input.lang === 'zh' || input.lang === 'en')
    ? { sessionId: input.sessionId, attemptId: input.attemptId, lang: input.lang } : undefined;
}
export function validFunnelContext(value: unknown): FunnelContext | undefined {
  const input = object(value);
  return input && Object.keys(input).length === 3 && Object.keys(input).every(key => ['sessionId', 'attemptId', 'lang'].includes(key))
    ? contextFields(input) : undefined;
}
/** No success-of-funds names, arbitrary metadata, URLs, error text or transaction fields. */
export function validFunnelClientEvent(value: unknown): FunnelClientEvent | undefined {
  const input = object(value);
  if (!input || !Object.keys(input).every(key => ['sessionId', 'attemptId', 'lang', 'eventId', 'event', 'walletType'].includes(key))) return;
  const context = contextFields(input);
  if (!context || !isFunnelId(input.eventId) || !FUNNEL_CLIENT_EVENTS.includes(input.event as FunnelClientEventName)
    || (input.walletType !== undefined && !['evm', 'tron', 'solana'].includes(input.walletType as string))) return;
  return { ...context, eventId: input.eventId, event: input.event as FunnelClientEventName,
    ...(input.walletType ? { walletType: input.walletType as 'evm' | 'tron' | 'solana' } : {}) };
}
