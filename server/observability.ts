import { NodeClient, Scope, makeNodeTransport, type NodeOptions } from '@sentry/node';
import { disabledMonitoring, monitoringBudget, monitoringEvent, noAutomaticData, publicMonitoringConfiguration,
  sanitizeMonitoringEnvelope, sanitizeMonitoringEvent, type MonitoringConfig, type MonitoringReporter } from '../shared/observability.js';
export { monitoringConfiguration } from '../shared/observability.js';

/** No global SDK initialization, HTTP instrumentation, console capture, sessions or tracing. */
export function createServerMonitoring(config?: MonitoringConfig, options: { transport?: NodeOptions['transport']; now?: () => number } = {}): MonitoringReporter {
  const valid = publicMonitoringConfiguration(config);
  if (!valid) return disabledMonitoring;
  try {
    let active = true;
    const client = new NodeClient({
      dsn: valid.dsn, environment: valid.environment, release: valid.release,
      integrations: [], stackParser: () => [],
      transport: transportOptions => {
        const transport = (options.transport ?? makeNodeTransport)(transportOptions);
        return { flush: timeout => transport.flush(timeout), send: envelope => {
          const safe = active ? sanitizeMonitoringEnvelope(envelope, 'node', valid) as typeof envelope | undefined : undefined;
          return safe ? transport.send(safe) : Promise.resolve({});
        } };
      },
      enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false, includeServerName: false,
      includeLocalVariables: false, attachStacktrace: false, sendClientReports: false, maxBreadcrumbs: 0,
      dataCollection: { ...noAutomaticData, httpBodies: [] }, tracePropagationTargets: [],
      beforeBreadcrumb: () => null, beforeSendLog: () => null, beforeSendMetric: () => null,
      beforeSend: (event, hint) => { hint.attachments = []; return active ? sanitizeMonitoringEvent(event, 'node', valid) : null; },
    });
    const scope = new Scope(); scope.setClient(client);
    const accept = monitoringBudget(options.now);
    return {
      get enabled() { return active; },
      report(context) {
        try { const event = monitoringEvent(context, 'node', valid); if (active && event && accept(event)) client.captureEvent(event, {}, scope); }
        catch { /* Monitoring must not alter the API, order state or funds path. */ }
      },
      async flush(timeoutMs = 1000) { try { return await client.flush(Math.min(2000, Math.max(0, timeoutMs))); } catch { return false; } },
      async close() { active = false; try { await client.close(1000); } catch { /* Best effort only. */ } },
    };
  } catch { return disabledMonitoring; }
}
