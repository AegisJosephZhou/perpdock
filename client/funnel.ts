import type { FunnelConfig, FunnelContext, FunnelClientEventName } from '../shared/funnel.js';
import { isFunnelId, validFunnelClientEvent } from '../shared/funnel.js';

const STORAGE_KEY = 'dock.funnel.v1';
const SESSION_MS = 30 * 60_000;
let enabled = false;
let language: 'zh' | 'en' = 'zh';
let current: { sessionId: string; lang: 'zh' | 'en'; expiresAt: number } | undefined;
let landed: string | undefined;

function emit(context: FunnelContext, event: FunnelClientEventName, walletType?: 'evm' | 'tron' | 'solana'): void {
  try {
    const payload = validFunnelClientEvent({ ...context, event, eventId: crypto.randomUUID(), ...(walletType ? { walletType } : {}) });
    if (!payload) return;
    void fetch('/api/funnel/events', {
      method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' },
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(2_000),
    }).catch(() => {});
  } catch { /* Losing an observation never changes a wallet or funding action. */ }
}
function ensureLanding(active: NonNullable<typeof current>): void {
  if (landed === active.sessionId) return;
  landed = active.sessionId;
  // Call the low-level emitter directly: obtaining a quote context must not recurse.
  emit({ sessionId: active.sessionId, lang: active.lang, attemptId: crypto.randomUUID() }, 'landing');
}

function session(): typeof current {
  if (!enabled) return;
  const now = Date.now();
  if (current && current.expiresAt <= now) current = undefined;
  if (!current) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
      if (saved && Object.keys(saved).length === 3 && isFunnelId(saved.sessionId)
        && ['zh', 'en'].includes(saved.lang) && Number.isFinite(saved.expiresAt)
        && saved.expiresAt > now && saved.expiresAt <= now + SESSION_MS) current = saved;
    } catch { /* Analytics storage is separate from recovery storage and optional. */ }
  }
  if (!current) {
    current = { sessionId: crypto.randomUUID(), lang: language, expiresAt: now + SESSION_MS };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* Memory-only session. */ }
  }
  return current;
}

/** No UTM requirement; no cookies, URL/referrer collection, SDK or replay. */
export function startFunnel(config: FunnelConfig | undefined, lang: 'zh' | 'en'): void {
  try {
    enabled = config?.enabled === true; language = lang;
    if (!enabled) {
      current = undefined; landed = undefined;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Never touch payment storage. */ }
      return;
    }
    const active = session();
    if (active) ensureLanding(active);
  } catch { current = undefined; /* Analytics never stops rendering. */ }
}

export function newFunnelAttempt(): string | undefined {
  try { return enabled ? crypto.randomUUID() : undefined; } catch { return; }
}

/** Each API quote attempt has a new ID; the random tab session is shared with all stages. */
export function getQuoteFunnel(): FunnelContext | undefined {
  try {
    const active = session();
    if (active) ensureLanding(active);
    return active ? { sessionId: active.sessionId, lang: active.lang, attemptId: crypto.randomUUID() } : undefined;
  } catch { return; }
}

export function trackFunnel(event: FunnelClientEventName, options: { attemptId?: string; walletType?: 'evm' | 'tron' | 'solana' } = {}): void {
  try {
    const context = getQuoteFunnel();
    if (!context) return;
    if (event === 'landing') return; // getQuoteFunnel already ensured it for this session.
    emit({ ...context, ...(options.attemptId ? { attemptId: options.attemptId } : {}) }, event, options.walletType);
  } catch { /* Losing an observation never changes a wallet or funding action. */ }
}

/** Operational timestamps are authenticated first-party claims, independently of optional analytics.
 * Never await this before signing/broadcasting. Two bounded attempts reuse one event ID.
 * No hash is sent: Solana may obtain its signature before the transaction is broadcast.
 */
export function reportOrderStage(saved: { id: string; accessToken: string }, stage: 'signing' | 'broadcast'): void {
  try {
    const payload = JSON.stringify({ stage, eventId: crypto.randomUUID(), observedAt: new Date().toISOString() });
    const send = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetch(`/api/orders/${encodeURIComponent(saved.id)}/stage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saved.accessToken}` },
            body: payload, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(2_000),
          });
          if (response.ok || (response.status >= 400 && response.status < 500)) return;
        } catch { /* Retry the same declaration, never the payment. */ }
      }
    };
    void send().catch(() => {});
  } catch { /* Even UUID/clock/fetch failures must not alter payment recovery. */ }
}
