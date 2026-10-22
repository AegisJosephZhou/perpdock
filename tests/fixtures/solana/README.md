# Solana protocol fixture

`quote.json` is an unsigned public Relay quote for 10 Solana native USDC to Hyperliquid default Perps USDC. Both addresses are synthetic test inputs. No wallet transaction was signed or broadcast. The captured signature belongs to Relay's order attestation, not a user wallet. `chains.json` is the matching public canonical registry subset.

Primary references:
- https://api.relay.link/chains
- https://docs.relay.link/references/api/api_guides/solana
- https://docs.relay.link/references/api/api_core_concepts/input-validation
- https://docs.relay.link/references/api/api_guides/hyperliquid-support
- https://developers.circle.com/stablecoins/usdc-contract-addresses
- `@relay-protocol/settlement-sdk@0.0.147`, published v1 order address encoding and Solana `deposit_token` IDL.

The reviewed deposit has one instruction and ten account positions. Its bytes are the eight-byte Anchor discriminator, a little-endian u64 token amount, and the exact 32-byte protocol order ID. Source and vault token accounts are independently derived from the canonical mint, token program, and owner. Lookup tables in the provider response only compress account keys; the application validates the complete instruction and rebuilds a legacy transaction without lookup tables.

These fixtures prove quote parsing and deterministic binding. They are not evidence of a real user payment or a completed Hyperliquid credit.
