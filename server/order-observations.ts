import type { Order, OrderTimings } from '../shared/types.js';

export function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** Read-time compatibility: recover only times backed by stored facts, never from updatedAt. */
export function observedTimings(order: Order, quotedAt?: string): OrderTimings {
  const first = (statuses: string[]) => order.events.find(event => statuses.includes(event.status) && validTime(event.at))?.at;
  const existing = order.timings ?? {};
  const time = (value: unknown) => validTime(value) ? value : undefined;
  return {
    quoteObservedAt: time(existing.quoteObservedAt) ?? time(order.quote.observedAt) ?? time(quotedAt),
    sourceSubmittedObservedAt: order.sourceTxHash ? time(existing.sourceSubmittedObservedAt) ?? first(['source_pending', 'bridging', 'verifying_credit', 'completed']) : undefined,
    sourceConfirmedObservedAt: order.sourceTxHash ? time(existing.sourceConfirmedObservedAt) ?? first(['bridging', 'verifying_credit', 'completed']) : undefined,
    creditVerifiedObservedAt: order.status === 'completed' ? time(existing.creditVerifiedObservedAt) ?? first(['completed']) : undefined,
    destinationLedgerAt: order.status === 'completed' ? time(existing.destinationLedgerAt) : undefined,
  };
}

/** Only genuine state transitions advance the current stage clock; repeated outage messages do not. */
export function currentStageSince(order: Order): string | undefined {
  let previous: string | undefined, since: string | undefined;
  for (const event of order.events) {
    if (event.status !== previous) since = validTime(event.at) ? event.at : undefined;
    previous = event.status;
  }
  return previous === order.status ? since : undefined;
}
