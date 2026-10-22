/** Monitoring is a separate, opt-in channel. Never accept arbitrary tags or error text. */
export interface MonitoringConfig {
  enabled: true;
  dsn: string;
  environment?: 'production' | 'staging' | 'development';
  release?: string;
}

const stages = ['client_api', 'react_render', 'window_error', 'unhandled_rejection', 'server_api', 'server_start', 'order_tracking'] as const;
const routes = ['/', '/api/config', '/api/health', '/api/ready', '/api/quotes', '/api/orders', '/api/orders/:id',
  '/api/orders/:id/transaction', '/api/orders/:id/refresh', '/api/orders/:id/stage', '/api/account/:address', '/api/unknown'] as const;
const routeIds = new Set(['ethereum-usdt-hypercore', 'ethereum-usdc-hypercore', 'arbitrum-usdt-hypercore',
  'arbitrum-usdc-hypercore', 'base-usdc-hypercore', 'optimism-usdc-hypercore', 'polygon-usdc-hypercore',
  'bsc-usdt-hypercore', 'tron-usdt-hypercore', 'solana-usdc-hypercore']);
const codes = new Set(['UNEXPECTED_ERROR', 'HTTP_ERROR', 'NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_RESPONSE',
  'REACT_RENDER_ERROR', 'WINDOW_ERROR', 'UNHANDLED_REJECTION', 'SERVER_START_FAILED',
  'AUTHENTICATION_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_JSON', 'INVALID_REQUEST',
  'JSON_REQUIRED', 'NOT_FOUND', 'ORIGIN_NOT_ALLOWED', 'RATE_LIMITED', 'INVALID_ADDRESS', 'INVALID_AMOUNT',
  'UNSUPPORTED_ROUTE', 'UNSAFE_PROVIDER_QUOTE', 'PROVIDER_AUTH_REQUIRED', 'PROVIDER_RATE_LIMIT',
  'UPSTREAM_HTTP_ERROR', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_RESPONSE_TOO_LARGE', 'INVALID_UPSTREAM_RESPONSE',
  'AMOUNT_OUT_OF_RANGE', 'FUNDING_PAUSED', 'INVALID_PROVIDER_QUOTE', 'INVALID_RECIPIENT', 'INVALID_SOURCE_ADDRESS',
  'INVALID_TRACKING_EVIDENCE', 'INVALID_TRACKING_UPDATE', 'ORDER_NOT_FOUND', 'QUOTE_EXPIRED', 'QUOTE_NOT_FOUND',
  'ROUTE_UNAVAILABLE', 'TRANSACTION_CONFLICT', 'TRANSACTION_MISMATCH', 'INVALID_PRECISION', 'INVALID_TX_HASH',
  'IDEMPOTENCY_CONFLICT', 'INVALID_PROVIDER_STATE', 'QUOTE_ALREADY_USED', 'TRANSACTION_ALREADY_ASSIGNED',
  'EVM_NETWORK_MISMATCH', 'EVM_RPC_CONFIG', 'EVM_RPC_ERROR', 'EVM_TOKEN_MISMATCH', 'INVALID_LEDGER_RANGE',
  'SOLANA_ACCOUNT_MISMATCH', 'SOLANA_NETWORK_MISMATCH', 'SOLANA_RPC_CONFIG', 'SOLANA_RPC_ERROR']);

export interface MonitoringContext {
  stage: typeof stages[number];
  route?: typeof routes[number];
  code?: string;
  status?: number;
  requestId?: string;
  routeId?: string;
  location?: MonitoringLocation;
}
export interface MonitoringLocation { file: 'app:///assets/index.js'; line: number; column: number }
export interface MonitoringReporter {
  readonly enabled: boolean;
  report(context: MonitoringContext): void;
  flush(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}
export const disabledMonitoring: MonitoringReporter = Object.freeze({ enabled: false,
  report: () => {}, flush: async () => true, close: async () => {} });

/** SaaS-only DSNs, with no secret, query, fragment, port or arbitrary collector host. */
export function monitoringConfiguration(enabled?: string, dsn?: string, environment?: string, release?: string): MonitoringConfig | undefined {
  if (enabled !== 'true' || !dsn || dsn.length > 256) return;
  try {
    const url = new URL(dsn);
    if (url.protocol !== 'https:' || !/^[a-f\d]{32}$/i.test(url.username) || url.password || url.port || url.search || url.hash
      || !/^o\d+\.ingest(?:\.(?:us|de))?\.sentry\.io$/.test(url.hostname) || !/^\/[1-9]\d{0,19}$/.test(url.pathname)) return;
    if (environment && !['production', 'staging', 'development'].includes(environment)) return;
    if (release && !/^(?:[a-f\d]{7,40}|v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z\d.-]{1,32})?)$/.test(release)) return;
    return { enabled: true, dsn: url.href, ...(environment ? { environment: environment as MonitoringConfig['environment'] } : {}), ...(release ? { release } : {}) };
  } catch { return; }
}

export function publicMonitoringConfiguration(value: unknown): MonitoringConfig | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const config = value as Record<string, unknown>;
    if (config.enabled !== true || typeof config.dsn !== 'string'
      || (config.environment !== undefined && typeof config.environment !== 'string')
      || (config.release !== undefined && typeof config.release !== 'string')) return;
    return monitoringConfiguration('true', config.dsn, config.environment as string | undefined, config.release as string | undefined);
  } catch { return; }
}

export function apiRouteTemplate(path: string): MonitoringContext['route'] {
  const clean = path.split(/[?#]/, 1)[0];
  if (['/config', '/health', '/ready', '/quotes', '/orders'].includes(clean)) return `/api${clean}` as MonitoringContext['route'];
  if (/^\/orders\/[^/]+\/transaction$/.test(clean)) return '/api/orders/:id/transaction';
  if (/^\/orders\/[^/]+\/refresh$/.test(clean)) return '/api/orders/:id/refresh';
  if (/^\/orders\/[^/]+\/stage$/.test(clean)) return '/api/orders/:id/stage';
  if (/^\/orders\/[^/]+$/.test(clean)) return '/api/orders/:id';
  if (/^\/account\/[^/]+$/.test(clean)) return '/api/account/:address';
  return '/api/unknown';
}

/** Rebuild rather than redact: unknown keys, arbitrary codes and identifiers never survive. */
export function safeMonitoringContext(value: unknown): Record<string, string | number> | undefined {
  try {
    if (!value || typeof value !== 'object') return;
    const input = value as Record<string, unknown>;
    if (!stages.includes(input.stage as typeof stages[number])) return;
    const result: Record<string, string | number> = { stage: input.stage as string,
      code: typeof input.code === 'string' && codes.has(input.code) ? input.code : 'UNEXPECTED_ERROR' };
    if (routes.includes(input.route as typeof routes[number])) result.route = input.route as string;
    if (typeof input.status === 'number' && Number.isInteger(input.status) && input.status >= 400 && input.status <= 599) result.status = input.status;
    if (typeof input.requestId === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(input.requestId)) result.requestId = input.requestId;
    if (typeof input.routeId === 'string' && routeIds.has(input.routeId)) result.routeId = input.routeId;
    const location = (input.location ?? { file: input.codeFile, line: input.codeLine, column: input.codeColumn }) as Partial<MonitoringLocation>;
    if (location && location.file === 'app:///assets/index.js' && Number.isInteger(location.line) && Number.isInteger(location.column)
      && location.line! > 0 && location.line! <= 10_000_000 && location.column! > 0 && location.column! <= 10_000_000) {
      result.codeFile = location.file; result.codeLine = location.line!; result.codeColumn = location.column!;
    }
    return result;
  } catch { return; }
}

export interface SafeMonitoringEvent {
  type: undefined;
  event_id?: string; timestamp?: number;
  level: 'error'; platform: 'javascript' | 'node'; message: string;
  environment?: MonitoringConfig['environment']; release?: string;
  contexts: { dock: Record<string, string | number> };
  tags: Record<string, string>;
  fingerprint: string[];
  exception?: { values: { type: string; value: string; stacktrace: { frames: { filename: string; lineno: number; colno: number; in_app: true }[] } }[] };
}
export function monitoringEvent(context: unknown, platform: 'javascript' | 'node', config?: MonitoringConfig): SafeMonitoringEvent | null {
  const safe = safeMonitoringContext(context);
  if (!safe) return null;
  return { type: undefined, level: 'error', platform, message: `Dock ${safe.stage}: ${safe.code}`,
    ...(config?.environment ? { environment: config.environment } : {}), ...(config?.release ? { release: config.release } : {}),
    contexts: { dock: safe }, tags: { stage: String(safe.stage), code: String(safe.code), ...(safe.route ? { route: String(safe.route) } : {}),
      ...(safe.routeId ? { routeId: String(safe.routeId) } : {}) },
    fingerprint: ['dock', platform, String(safe.stage), String(safe.code), String(safe.route ?? 'unknown'),
      ...(safe.codeFile ? [String(safe.codeFile), String(safe.codeLine), String(safe.codeColumn)] : [])],
    ...(safe.codeFile ? { exception: { values: [{ type: String(safe.code), value: `Dock ${safe.stage}`,
      stacktrace: { frames: [{ filename: String(safe.codeFile), lineno: Number(safe.codeLine), colno: Number(safe.codeColumn), in_app: true as const }] } }] } } : {}) };
}

/** Last-mile filter also removes any SDK/global-scope enrichment before transport. */
export function sanitizeMonitoringEvent(event: unknown, platform: 'javascript' | 'node', config: MonitoringConfig): SafeMonitoringEvent | null {
  try {
    if (!event || typeof event !== 'object') return null;
    const input = event as Record<string, unknown>;
    const contexts = input.contexts as { dock?: unknown } | undefined;
    const safe = monitoringEvent(contexts?.dock, platform, config);
    if (!safe || input.message !== safe.message) return null;
    if (typeof input.event_id === 'string' && /^[a-f\d]{32}$/i.test(input.event_id)) safe.event_id = input.event_id;
    if (typeof input.timestamp === 'number' && Number.isFinite(input.timestamp) && input.timestamp > 0) safe.timestamp = input.timestamp;
    return safe;
  } catch { return null; }
}

/** SDK hints may carry attachments outside the event. Only one rebuilt error item may leave. */
export function sanitizeMonitoringEnvelope(envelope: unknown, platform: 'javascript' | 'node', config: MonitoringConfig): unknown | undefined {
  try {
    if (!Array.isArray(envelope) || !Array.isArray(envelope[1])) return;
    for (const item of envelope[1]) {
      if (!Array.isArray(item) || item[0]?.type !== 'event') continue;
      const event = sanitizeMonitoringEvent(item[1], platform, config);
      if (event) return [{ ...(event.event_id ? { event_id: event.event_id } : {}) }, [[{ type: 'event' }, event]]];
    }
  } catch { /* Drop malformed and non-event SDK envelopes. */ }
}

export const noAutomaticData = {
  userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
  graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
  databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0,
} as const;

/** Bound repeated failures; request IDs never become a high-cardinality grouping key. */
export function monitoringBudget(now: () => number = Date.now): (event: SafeMonitoringEvent) => boolean {
  let start = now(); let count = 0; const last = new Map<string, number>();
  return event => {
    const time = now();
    if (time - start >= 60_000 || time < start) { start = time; count = 0; last.clear(); }
    if (count >= 20) return false;
    const key = `${event.fingerprint.join('|')}|${event.contexts.dock.status ?? ''}|${event.contexts.dock.routeId ?? ''}`;
    const previous = last.get(key);
    if (previous !== undefined && time - previous < 10_000) return false;
    last.set(key, time); count++; return true;
  };
}
