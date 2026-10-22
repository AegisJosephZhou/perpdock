import type { AttributionConfig, AttributionContext } from '../shared/attribution.js';
import { validAttribution, validCampaignList } from '../shared/attribution.js';

const STORAGE_KEY = 'dock.attribution.v1';
const SESSION_MS = 30 * 60_000;
let current: { context: AttributionContext; expiresAt: number } | undefined;
let configured: AttributionConfig | undefined;
let language: 'zh' | 'en' = 'zh';
let submittedSession: string | undefined;

/** Best-effort only. Does not access wallet/payment storage or await any funding operation. */
export function startAttribution(config: AttributionConfig | undefined, lang: 'zh' | 'en'): void {
  try {
    language = lang;
    if (!config?.enabled || !validCampaignList(config.campaigns)) {
      configured = undefined; current = undefined; submittedSession = undefined;
      try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* No storage required. */ }
      return;
    }
    configured = { enabled: true, campaigns: [...config.campaigns] };
    const now = Date.now();
    if (current && (current.expiresAt <= now || !validAttribution(current.context, config.campaigns))) current = undefined;
    if (!current) {
      try {
        const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
        if (saved && typeof saved === 'object' && 'context' in saved && 'expiresAt' in saved) {
          const context = validAttribution(saved.context, config.campaigns);
          const expiresAt = saved.expiresAt;
          if (context && typeof expiresAt === 'number' && Number.isFinite(expiresAt)
            && expiresAt > now && expiresAt <= now + SESSION_MS) current = { context, expiresAt };
        }
      } catch { /* Blocked or malformed storage only loses attribution. */ }
    }
    if (!current) {
      const query = new URLSearchParams(window.location.search);
      const keys = ['utm_campaign', 'utm_source', 'utm_medium'];
      if (keys.some(key => query.getAll(key).length !== 1)) return;
      const context = validAttribution({
        sessionId: crypto.randomUUID(), campaign: query.get('utm_campaign'),
        source: query.get('utm_source'), medium: query.get('utm_medium'), lang,
      }, config.campaigns);
      if (!context) return;
      current = { context, expiresAt: now + SESSION_MS };
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* In-memory fallback. */ }
    }
    if (submittedSession === current.context.sessionId) return;
    submittedSession = current.context.sessionId;
    // Never send URL/referrer, event names, funds, wallets, or credentials. No automatic retry loop.
    void fetch('/api/attribution/landing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current.context), credentials: 'omit', referrerPolicy: 'no-referrer',
      cache: 'no-store', signal: AbortSignal.timeout(3_000),
    }).catch(() => {});
  } catch { current = undefined; /* Analytics must never stop the app. */ }
}

/** First valid source in this tab session; language is the first observed UI language. */
export function getQuoteAttribution(): AttributionContext | undefined {
  try {
    if (!configured) return undefined;
    if (current && current.expiresAt <= Date.now()) startAttribution(configured, language);
    return current ? { ...current.context } : undefined;
  } catch { return undefined; }
}
