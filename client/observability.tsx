import { Component, type ReactNode } from 'react';
import { BrowserClient, Scope, makeFetchTransport, type BrowserOptions } from '@sentry/react';
import { disabledMonitoring, monitoringBudget, monitoringEvent, noAutomaticData, publicMonitoringConfiguration,
  sanitizeMonitoringEnvelope, sanitizeMonitoringEvent, type MonitoringConfig, type MonitoringContext, type MonitoringLocation, type MonitoringReporter } from '../shared/observability.js';

/** Keep only an entry-bundle location. URL, query, build hash and function name never leave. */
export function safeBrowserLocation(filename: unknown, line: unknown, column: unknown, origin: string): MonitoringLocation | undefined {
  try {
    if (typeof filename !== 'string' || filename.length > 4096 || typeof line !== 'number' || typeof column !== 'number'
      || !Number.isInteger(line) || !Number.isInteger(column) || line <= 0 || column <= 0 || line > 10_000_000 || column > 10_000_000) return;
    const url = new URL(filename);
    if (url.origin !== origin || url.username || url.password || !/^\/assets\/index-[A-Za-z0-9_-]{6,16}\.js$/.test(url.pathname)) return;
    return { file: 'app:///assets/index.js', line, column };
  } catch { return; }
}
export function safeBrowserStackLocation(error: unknown, origin: string): MonitoringLocation | undefined {
  try {
    if (!error || typeof error !== 'object' || !('stack' in error) || typeof error.stack !== 'string' || error.stack.length > 32768) return;
    for (const line of error.stack.split('\n').slice(1, 21)) {
      const match = /(?:\(|\s|@)(https?:\/\/[^\s)]+):(\d+):(\d+)\)?$/.exec(line);
      if (match) { const location = safeBrowserLocation(match[1], Number(match[2]), Number(match[3]), origin); if (location) return location; }
    }
  } catch { /* Hostile error getters are never allowed to affect recovery. */ }
}

export function createBrowserMonitoring(config?: MonitoringConfig, options: { transport?: BrowserOptions['transport']; now?: () => number } = {}): MonitoringReporter {
  const valid = publicMonitoringConfiguration(config);
  if (!valid) return disabledMonitoring;
  try {
    let active = true;
    const client = new BrowserClient({
      dsn: valid.dsn, environment: valid.environment, release: valid.release,
      integrations: [], stackParser: () => [],
      transport: transportOptions => {
        const transport = (options.transport ?? makeFetchTransport)(transportOptions);
        return { flush: timeout => transport.flush(timeout), send: envelope => {
          const safe = active ? sanitizeMonitoringEnvelope(envelope, 'javascript', valid) as typeof envelope | undefined : undefined;
          return safe ? transport.send(safe) : Promise.resolve({});
        } };
      },
      attachStacktrace: false, sendClientReports: false, maxBreadcrumbs: 0,
      dataCollection: { ...noAutomaticData, httpBodies: [] }, tracePropagationTargets: [],
      beforeBreadcrumb: () => null, beforeSendLog: () => null, beforeSendMetric: () => null,
      beforeSend: (event, hint) => { hint.attachments = []; return active ? sanitizeMonitoringEvent(event, 'javascript', valid) : null; },
    });
    const scope = new Scope(); scope.setClient(client);
    const accept = monitoringBudget(options.now);
    return {
      get enabled() { return active; },
      report(context) {
        try { const event = monitoringEvent(context, 'javascript', valid); if (active && event && accept(event)) client.captureEvent(event, {}, scope); }
        catch { /* Never let monitoring failure affect payments or recovery. */ }
      },
      async flush(timeoutMs = 1000) { try { return await client.flush(Math.min(2000, Math.max(0, timeoutMs))); } catch { return false; } },
      async close() { active = false; try { await client.close(1000); } catch { /* Best effort only. */ } },
    };
  } catch { return disabledMonitoring; }
}

let current: MonitoringReporter = disabledMonitoring;
let configuration = '';
let removeHooks: (() => void) | undefined;
/** Called only after the server explicitly publishes an enabled configuration. */
export function configureBrowserMonitoring(value: unknown): void {
  try {
    const config = publicMonitoringConfiguration(value);
    const key = config ? JSON.stringify(config) : '';
    if (key === configuration) return;
    configuration = key;
    removeHooks?.(); removeHooks = undefined;
    const previous = current; current = disabledMonitoring; void previous.close().catch(() => {});
    if (!config) return;
    current = createBrowserMonitoring(config);
    if (!current.enabled || typeof window === 'undefined') return;
    // Read only the code location; never read a message, rejection reason or event target.
    const onError = (event: ErrorEvent) => reportClientError({ stage: 'window_error', route: '/', code: 'WINDOW_ERROR',
      location: safeBrowserLocation(event.filename, event.lineno, event.colno, window.location.origin) });
    const onRejection = () => reportClientError({ stage: 'unhandled_rejection', route: '/', code: 'UNHANDLED_REJECTION' });
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    removeHooks = () => { window.removeEventListener('error', onError); window.removeEventListener('unhandledrejection', onRejection); };
  } catch { /* Malformed configuration must not stop the application. */ }
}
export function reportClientError(context: MonitoringContext): void { try { current.report(context); } catch { /* Best effort. */ } }
export async function flushBrowserMonitoring(): Promise<boolean> { try { return await current.flush(); } catch { return false; } }

export class MonitoringErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { reportClientError({ stage: 'react_render', route: '/', code: 'REACT_RENDER_ERROR',
    location: typeof window === 'undefined' ? undefined : safeBrowserStackLocation(error, window.location.origin) }); }
  render() {
    if (!this.state.failed) return this.props.children;
    const english = typeof document !== 'undefined' && document.documentElement.lang.startsWith('en');
    return <main role="alert"><h1>{english ? 'The page could not continue' : '页面暂时无法继续'}</h1>
      <p>{english ? 'If you already signed a payment, keep your wallet records and do not pay again. Reload this page to recover the original order.' : '如果已经签名付款，请保留钱包记录，不要再次付款。刷新页面后恢复原订单。'}</p>
      <button onClick={() => window.location.reload()}>{english ? 'Reload page' : '刷新页面'}</button></main>;
  }
}
