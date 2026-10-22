/** Only approved marketing labels; never URLs, addresses, or user-entered free text. */
export const ATTRIBUTION_SOURCES = ['x', 'partner', 'community'] as const;
export const ATTRIBUTION_MEDIA = ['organic_social', 'referral'] as const;
export const ATTRIBUTION_LANGUAGES = ['zh', 'en'] as const;
export const CAMPAIGN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AttributionContext {
  sessionId: string;
  campaign: string;
  source: typeof ATTRIBUTION_SOURCES[number];
  medium: typeof ATTRIBUTION_MEDIA[number];
  lang: typeof ATTRIBUTION_LANGUAGES[number];
}
export interface AttributionConfig { enabled: true; campaigns: string[] }

/** Returns a new, narrow object. Invalid metadata is discarded, never repaired or truncated. */
export function validAttribution(value: unknown, campaigns: readonly string[]): AttributionContext | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = ['sessionId', 'campaign', 'source', 'medium', 'lang'];
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key))) return undefined;
  const { sessionId, campaign, source, medium, lang } = input;
  if (typeof sessionId !== 'string' || !SESSION_PATTERN.test(sessionId)
    || typeof campaign !== 'string' || !CAMPAIGN_PATTERN.test(campaign) || !campaigns.includes(campaign)
    || !ATTRIBUTION_SOURCES.includes(source as AttributionContext['source'])
    || !ATTRIBUTION_MEDIA.includes(medium as AttributionContext['medium'])
    || !ATTRIBUTION_LANGUAGES.includes(lang as AttributionContext['lang'])) return undefined;
  if (source === 'x' ? medium !== 'organic_social' : medium !== 'referral') return undefined;
  return { sessionId, campaign, source, medium, lang } as AttributionContext;
}

export function validCampaignList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 100
    && value.every(item => typeof item === 'string' && CAMPAIGN_PATTERN.test(item))
    && new Set(value).size === value.length;
}
