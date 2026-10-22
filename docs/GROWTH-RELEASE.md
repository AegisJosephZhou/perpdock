# Dock language and attribution update

This update adds Chinese and English interface support and optional first-party campaign attribution. It preserves the existing funding routes, wallet authorization, payment recovery, source-chain verification, and per-order Hyperliquid Perps credit checks.

## Interface

- Select Chinese or English without resetting the form, quote, current order, or pending-payment protection.
- Open `?lang=zh` or `?lang=en` to select a language explicitly. Language preferences are optional; unavailable browser storage does not prevent use.
- Funding, fee, wallet, progress, and recovery messages distinguish authorization, payment, source confirmation, and verified Perps credit. Changing language does not initiate wallet actions.
- Dock remains a Perpex product. The interface includes the public Perpex support link.

## Optional attribution

Collection is disabled by default. Enabling it requires both `ATTRIBUTION_ENABLED=true` and an explicit `ATTRIBUTION_CAMPAIGNS` allowlist. The interface can be released with collection disabled.

Attribution accepts limited campaign/source/medium/language labels and random tab-session identifiers. Successful quotes and order stages are recorded from persisted server facts. Browser requests cannot declare a payment or deposit completed. The collector uses a separate database, independent landing-request limits, capacity bounds, and retention rules; collection failures do not change funding results.

Reports are private, offline, read-only aggregates. No public reporting endpoint is added. Session counts are not verified people, customers, revenue, or causal attribution. Unattributed orders and reserved test campaigns are excluded from campaign reports. Configuration, retention, report semantics, and examples are documented in [ATTRIBUTION.md](ATTRIBUTION.md).

## Compatibility and validation

This update does not migrate the existing funding database or replace order-token secrets. Existing orders and pending-payment records remain under their existing recovery and verification rules. Keep the established data volumes and configuration when releasing the application.

The packaged change passed 548 application tests, 43 deployment-tool tests, TypeScript checks, and the production build under Node 24. Desktop and narrow-screen checks covered both interface languages. These checks used isolated test data; they do not establish production deployment, live-wallet compatibility for every route, or successful real-money deposits.

The repository includes Docker/Compose deployment templates. Release through the deployment operator's existing process and record the actual deployed commit separately from the source-code release. Do not reset production configuration to sample defaults. The offline attribution report runs from a repository tool environment with Node 24 and development dependencies; the minimal runtime image does not include the report tooling.
