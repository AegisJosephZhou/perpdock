# Deposit observability

This release adds Sentry error reporting, a complete optional funnel with PostHog export, private operational order reports, and a Better Stack monitor configuration tool. Code delivery does not activate a SaaS project or change the production deployment. All external reporting defaults off. Existing marketing attribution remains separate.

## Order records come first

`funding.sqlite` remains the authoritative financial database, regardless of analytics flags. Each order retains its route, quote, status history, source/destination transaction references, verification evidence and tracking checks. New observations add quote time, browser signing/broadcast claims, source submission/confirmation observation, verified credit observation and matched destination ledger time.

Client claims never establish source confirmation or credit. Server observation time includes indexing and polling delay. Missing old stages remain unknown; the latest polling time is not an arrival time. Wallet cancellation, pending, attention and unavailable upstream queries are not automatically financial failures.

The offline [order report](ORDER-OPERATIONS.md) produces JSON summaries and CSV rows from a read-only database or consistent backup. It includes all orders in the creation cohort, including orders without marketing attribution. Use its explicit private identifier option when investigating a transaction. Keep these exports private; even default rows contain amounts and pseudonymous references. No public administration or order-list endpoint is added.

## Sentry

Set these runtime variables only when ready to enable reporting:

```dotenv
SENTRY_ENABLED=true
SENTRY_DSN=<public project DSN from Sentry>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=<immutable Git SHA or semantic version>
```

The server validates a Sentry SaaS DSN and exposes only that public configuration to the browser. An explicitly enabled invalid configuration stops startup with a fixed error. The CSP permits only the configured ingestion origin. SDKs are pinned to the same exact version.

Reports cover React rendering errors, window errors/unhandled rejections after configuration loads, failed frontend API calls server API error responses and unavailable background order-tracking queries. Reports use stage, safe error code, route template, HTTP status and the server-generated request ID where available. Browser errors can include a sanitized entry-bundle code location. Server diagnostics correlate with the existing request-ID log; raw exception messages and stacks are not uploaded. Reporting is bounded and failures do not change funding responses.

Automatic SDK integrations, user context, cookies, request/response bodies, headers, query strings, breadcrumbs, replay, tracing and profiling are disabled. No wallet address, amount, transaction hash, order access token or provider credential is sent. The Sentry service still receives the network connection's IP; this is not a claim of network anonymity. The browser can miss failures before configuration loads or when telemetry is blocked.

To verify after an approved release, use an isolated staging project and synthetic actions: trigger a render error and an API failure, inspect the final received event fields, and match a request ID to server logs. Do not use real wallet signing as a monitoring test.

### Isolated upstream failure drill

Run `npm test -- tests/observability-failure-drill.test.ts` to close a loopback upstream while exercising the real HTTP handler, SQLite stores and Sentry SDK. All providers, transactions and DSNs in this drill are synthetic. A custom SDK transport sends JSON envelopes only to a local HTTP receiver; this verifies event generation and local delivery, **not the production transport or receipt by Sentry SaaS**. Set `DOCK_FAILURE_DRILL_EVIDENCE` to a private output directory to save the checked event payloads and selected database observations as JSON.

A failed quote must return HTTP 503 with `UPSTREAM_UNAVAILABLE`, record `quote_requested` and `quote_failed` in the enabled local funnel, and leave the funding database without a quote or order for that attempt. The response header, error body and Sentry API event share a request ID. A quote failure occurs before an order exists; it is not a failed deposit.

For an existing synthetic order, an unavailable tracking upstream must preserve `bridging` and the source transaction, record `trackingCheck.result=unavailable` and the attempted time, preserve the last successful check time, and schedule another read. The operational report must show `queryUnavailable=true`. After the upstream recovers, a successful read clears the query-unavailable flag and retry count; it does not establish destination credit.

Correlation currently has limits: the funnel attempt does not store the HTTP request ID, and background Sentry events contain the route but no order identifier. They cannot be automatically joined one-to-one across those stores. Sentry also deduplicates matching errors within 10 seconds and caps reporting at 20 events per minute. Use the financial records for per-order state; Sentry is not an exhaustive transaction ledger.

## Funnel and PostHog

`FUNNEL_ENABLED=true` enables a separate local `funnel.sqlite` collector for all valid anonymous sessions, without requiring a campaign URL. `POSTHOG_ENABLED=false` keeps events local. To export, additionally set `POSTHOG_ENABLED=true`, a `POSTHOG_PROJECT_KEY`, and the project's ingestion region (`https://us.i.posthog.com` or `https://eu.i.posthog.com`). Keys stay on the server.

The [funnel guide](FUNNEL.md) defines event names, authority, report commands, deduplication and delivery limits. Wallet and browser actions are explicitly client observations. Quote success, order creation, verified source confirmation and credit are emitted from committed server state. Retries reuse stable event UUIDs. Export uses a bounded persistent queue, timeout, backoff and finite retries; delivery/drop counters expose incomplete collection. PostHog failure cannot cause a retry of a payment.

The browser uses a random tab session, with no autocapture, cookies, URL/referrer collection or replay. PostHog receives an explicit allowlist of random identifiers, event names, authority, route, wallet type and language; no financial identifiers or amounts. Session conversion is not a count of people or the authoritative deposit success rate. Use the financial report for the latter.

## Minute-level external uptime

`npm run uptime:configure` produces an offline Better Stack plan when `UPTIME_ORIGIN` is set to the intended HTTPS origin. It does not require an API token or make requests. The plan checks four URLs every 60 seconds from US, EU and Asia regions:

| Target | What it checks |
| --- | --- |
| `/` | The served page responds with HTTP 200 |
| `/api/health` | The application responds |
| `/api/config` | The route/configuration API responds |
| `/api/ready` | The application can read its local orders table |

These probes do not sign, create orders, obtain quotes, query a customer account, or prove that every upstream route or rendered browser interaction works. `/api/config` can intentionally return unavailable routes with HTTP 200. Chain/provider failures are also observed through API errors and order tracking reports.

After deployment approval, an operator can set `BETTERSTACK_API_TOKEN` privately (and `BETTERSTACK_TEAM_NAME` for a global token) and run `npm run uptime:configure -- --apply`. This explicitly creates or reconciles active monitors and enables email alerts to the account's configured recipients. The script refuses conflicting monitors, uses no automatic create retry after uncertain results, reads back settings, and requires an **effective** 60-second interval. It does not purchase or upgrade a plan; a slower account minimum or throttling is reported as incomplete setup. Configure the intended on-call recipients in Better Stack and test outage/recovery delivery on staging.

The API token belongs only in the operator environment, never the application container or Git. The application's Docker health check remains independent. This tool is never run during application startup, build or deployment checks. See the official [create-monitor API](https://betterstack.com/docs/uptime/api/create-a-new-monitor/) and [monitor readback fields](https://betterstack.com/docs/uptime/api/list-all-existing-monitors/).

## Release validation

Local tests use synthetic providers, in-memory or temporary databases and fake SaaS transports. They check safe outbound payloads, independent failure boundaries, authorized stage observations, legacy database reports, duplicate and concurrent observations, queue recovery and minute-monitor configuration. SaaS ingestion, alert delivery and production data volume require a later approved configuration and deployment; a green code test does not establish those results.
