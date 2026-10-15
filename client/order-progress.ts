import type { Order } from '../shared/types.js';

const sourceStages = new Set(['bridging', 'verifying_credit', 'completed']);
const validTime = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? value : undefined;

/** Presentation only. Payment/credit authorization remains in the existing validators. */
export function orderProgress(order: Order, credited: boolean) {
  const sourceEvent = order.events.find(event => sourceStages.has(event.status));
  const creditEvent = credited ? order.events.find(event => event.status === 'completed') : undefined;
  const sourceConfirmed = credited || !!order.sourceTxHash && (!!sourceEvent || ['bridging', 'verifying_credit'].includes(order.status));
  const routeReported = credited || order.status === 'verifying_credit' || order.events.some(event => event.status === 'verifying_credit');
  return {
    sourceConfirmed,
    routeReported,
    lastConfirmed: credited ? '本单已核实进入 HL 默认 Perps 账户' : sourceConfirmed ? '来源付款已最终确认' : '尚无已确认的资金步骤',
    confirmedAt: validTime(credited ? creditEvent?.at : sourceConfirmed ? sourceEvent?.at : undefined),
  };
}

/** A successful HTTP read of a saved order is not a new chain/provider check. */
export function trackingFreshness(order: Order, now: number) {
  const check = order.trackingCheck;
  const attemptedAt = validTime(check?.attemptedAt);
  const succeededAt = validTime(check?.succeededAt);
  const consistent = attemptedAt && Date.parse(attemptedAt) <= now + 5_000
    && (!succeededAt || Date.parse(succeededAt) <= Date.parse(attemptedAt));
  if (!consistent || !check || !['ok', 'unavailable'].includes(check.result)) {
    return { state: 'unknown' as const, attemptedAt: undefined, succeededAt: undefined };
  }
  return {
    attemptedAt,
    succeededAt,
    state: check.result === 'unavailable' ? 'unavailable' as const
      : !succeededAt ? 'unknown' as const
      : now - Date.parse(attemptedAt) > 60_000 ? 'stale' as const : 'current' as const,
  };
}
