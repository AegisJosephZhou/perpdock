# Anonymous funding funnel

Implementation is available in source; it is disabled by default. A code delivery is not evidence of production collection, PostHog ingestion or customer conversion.

## Configuration and lifecycle

`FUNNEL_ENABLED=true` enables the disposable first-party collector at `DATA_DIR/funnel.sqlite`. It includes visits without UTM parameters. Existing `ATTRIBUTION_ENABLED` and its approved campaign allowlist continue independently; do not add their counts to funnel counts.

`POSTHOG_ENABLED=true` additionally requires `POSTHOG_PROJECT_KEY` (the project ingestion token, never a personal API key) and `POSTHOG_HOST` equal to `https://us.i.posthog.com` or `https://eu.i.posthog.com`. An explicitly enabled PostHog integration with an absent or malformed key/host fails startup with a fixed, non-sensitive configuration message. When the funnel is disabled, PostHog is disabled too. With PostHog disabled, events stay local and are never backfilled automatically when export is enabled later. Credentials are server-side only.

The recorder constructor does no network I/O. `startExport()` schedules one batch per 10 seconds; `flush()` sends at most 50 events, uses a 3-second deadline, rejects redirects and coalesces simultaneous calls. Retryable failures (network, 408, 429, 5xx) back off from 5 seconds to 5 minutes, with at most five delivery attempts. Other 4xx responses are permanently dropped. A stable stored event UUID is reused on every retry. Shutdown waits only for a request already in progress and does not initiate an export. Production uses a single recorder/exporter per analytics database.

Local event keys deduplicate landing per session, quote stages per request/quote, and committed order stages per order. Queue state and UUIDs survive restart. A lost acknowledgement can cause a repeated HTTP submission with the same event UUID; remote ingestion is not an exactly-once financial ledger. An HTTP success means the ingestion endpoint accepted the batch, not that a dashboard has been independently verified.

The database caps retained sessions at 10,000, quote attempts at 50,000, orders at 50,000 and events at 100,000. Data older than 30 days is pruned during collection/export, at most hourly. Session expiry cascades through associated records. Counters expose capacity/export drops. An unavailable analytics database disables collection and emits only a fixed diagnostic; it does not undo or fail funding work. Local filesystem backups also need their own retention policy.

## Data and authority

The browser uses a fresh random UUID per 30-minute tab session, stored only in the funnel's own sessionStorage key. It never reuses a wallet address, account identifier or order token as an identity. Blocked storage falls back to memory. Session IDs link quotes and orders only in the local analytics database. PostHog receives only the session UUID, event UUID, fixed event name, timestamp, authority, language and an optional allowlisted route or wallet family.

No wallet/source/recipient addresses, amounts, transaction hashes, quote/order IDs, access tokens, raw errors, URL/referrer/query strings, visitor IPs, browser fingerprints or user agents are included in the export payload. Requests go from the server to PostHog; no visitor IP header is forwarded. The network transport necessarily exposes the server's egress IP to its peer. Configure the PostHog project's IP capture setting to discard IP data too. Every event disables GeoIP enrichment and person profile processing. There is no browser PostHog SDK, autocapture, session replay, exception capture, identify/alias call or person-property write.

| PostHog event (`dock_` prefix) | Source and meaning |
|---|---|
| `landing` | Client reports the page session after optional config enabled |
| `wallet_connect_started`, `wallet_connect_succeeded`, `wallet_connect_failed` | Client UI connection attempt; never contains addresses or error text |
| `quote_requested`, `quote_succeeded`, `quote_failed` | Server request, saved validated quote, or request failure; independent of the old UTM collector |
| `quote_response_failed` | Client API failed to return a readable quote response; may coexist with a server success or failure |
| `order_create_started`, `order_create_failed` | Client creation request observation; a lost response can occur after a successful server commit |
| `order_created` | Server committed an order, deduplicated across idempotent retries |
| `signing_started` | Authenticated client declaration, timestamped when the server receives it; not proof of signing |
| `signing_rejected`, `signing_failed` | Client observed rejection/error before a transaction reference was available; unknown errors do not declare a failed transfer |
| `payment_reference_observed` | Client received a transaction reference. On Solana this can happen before broadcast |
| `broadcast_observed` | Authenticated client declaration after `sendPayment` returned, not a network-confirmation claim |
| `payment_outcome_unknown`, `source_report_failed` | Client observation of uncertainty/reporting failure; preserves original payment recovery and never initiates repayment |
| `source_confirmed` | Server source verification committed a confirmed stage |
| `credit_verified` | Server committed `completed` with bound destination credit evidence and sufficient credited amount |

Client endpoint allowlists exclude server success events. Authenticated timing declarations cannot change financial state or add a transaction hash. Payment stage reporting is independent of analytics enablement: it records operational timestamps through the order-token-protected API, with two bounded attempts of the same declaration and no awaited dependency before wallet work. Existing durable signing markers, payment locks, saved hashes and unknown-state protections remain in control of payment safety.

Client observations are spoofable and may be dropped. Treat them as UI funnel diagnostics, not financial evidence. A single session can connect multiple wallets or attempt multiple quotes/orders; sessions are not unique humans. Retention and blocked requests can create missing stages. Never sum `quote_response_failed` with `quote_failed` as unique failures, nor count `broadcast_observed`/`payment_reference_observed` as completion.

## Offline report and PostHog funnel

Run locally with Node 22.13+ and the project's TypeScript loader:

```sh
node --import tsx scripts/funnel-report.ts --database /path/to/data/funnel.sqlite --from 2026-10-22 --until 2026-10-23
```

The report is read-only and aggregates first-observed session cohorts, per-event observations/sessions, linked quote/order counts, delivery states and drop counters. The end date is exclusive in UTC. It never opens the financial database or returns identifiers. No rows means no retained observations, not proven zero visitors/orders/revenue. Separate order timing reports own financial duration calculations; client declarations are not substituted for server/ledger timestamps.

In PostHog, build a session-identity funnel from `dock_landing` → `dock_wallet_connect_succeeded` → `dock_quote_succeeded` → `dock_order_created` → `dock_signing_started` → `dock_broadcast_observed` → `dock_source_confirmed` → `dock_credit_verified`. Use a 30-minute conversion window for a visit view, and explicitly label longer pending-funds analyses. Break down by fixed route or language. A payment may recover in another visit or complete later, so also inspect the server order cohorts; absence from the strict visit funnel does not mean payment failed. Intermediate client stages can be missing even for completed orders. No dashboard is automatically created and no historical production data is fabricated.

Official references checked during implementation: [Capture and batch API](https://posthog.com/docs/api/capture), [anonymous events](https://posthog.com/docs/data/anonymous-vs-identified-events), [IP data collection controls](https://posthog.com/docs/privacy/data-collection), and the [PostHog capture payload specification](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/capture/spec.md). The capture implementation uses a narrow HTTP payload rather than a general browser SDK.
