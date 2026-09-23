# AlphaBasket

AlphaBasket is a Solana native protocol for thesis driven investing.

Instead of investing in individual assets, users invest in ideas.

Creators build onchain indexes around a specific thesis, while users gain diversified exposure through a single investment.

Examples include:

- AI Infrastructure
- Solana Ecosystem
- Semiconductors
- Robotics
- Stablecoin Adoption
- Trump Trade
- Energy
- Any custom investment thesis

---

## Supported Asset Classes

AlphaBasket is designed to support multiple onchain asset classes through a modular execution architecture.

Current Integrations:

- Tokenized Stocks
- Crypto Assets
- Prediction Markets
- Perpetual Markets
- Other programmable onchain assets

---

## Core Principles

- Real asset backed portfolios
- Fully onchain accounting
- Modular execution adapters
- Creator owned index strategies
- Composable Solana native architecture

---

## Architecture

AlphaBasket deliberately separates portfolio accounting from execution.

The Accounting Engine remains unchanged regardless of where assets are traded.

Execution adapters can plug into different liquidity venues while sharing the same accounting, portfolio, fee, and lifecycle logic.

Current adapters:

- Backpack Securities
- Polymarket
- Jupiter
- Phoenix

## Vision

Every investment starts with a thesis.

Today, investors manually build portfolios around that thesis.

AlphaBasket turns those ideas into programmable, investable onchain indexes.

Our goal is to become the infrastructure layer for thesis driven investing on Solana.

Built with ❤️ on Solana


Configured devnet program ID:
`5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm`.

## Share accounting and fees

```text
Share price = current basket NAV / total shares outstanding
Shares minted = actual net deposit value / current share price
```

One share equals one US dollar only for the basket's first-ever deposit. Future
deposits and withdrawals use the current off-chain NAV and on-chain share
supply.

Current fee model:

| Fee | Recipient | Rule |
| --- | --- | --- |
| Performance | Creator | 0–20%, default 10%, charged only on redeemed-share profit |

Management fees do not sell Basket positions. The program mints protocol
shares, diluting the existing supply. A scheduled keeper accrues active baskets,
and every financial/lifecycle instruction provides a lazy-accrual fallback.

Performance fees follow redeemed-share high-water/cost-basis accounting so
burned shares cannot be charged twice. Multiple deposits use weighted-average
cost basis and holding time.

Composition constraints:

- Prediction-only or spot-only basket: 3,000 bps maximum per item.
- Mixed Polymarket/Jupiter basket: 2,000 bps maximum per item.
- Composition weights must total 10,000 bps.

## On-chain program

Location: `solana-escrow/`

The program stores four primary account types:

- `Config`: authorities, protocol destinations, limits and pause state.
- `Basket`: signed composition, lifecycle, share supply and fee state.
- `Position`: user shares, weighted cost basis, holding time and reserved
  extension space.
- `SettlementReceipt`: immutable replay protection for completed external
  executions.

Important instructions:

| Instruction | Purpose |
| --- | --- |
| `initialize` | Initialize protocol configuration and signer roles |
| `create_basket` | Verify the Composer Ed25519 authorization and create a basket |
| `complete_deposit` | Verify the signed user intent and credit shares after external execution |
| `complete_withdrawal` | Burn shares and record the verified mainnet payout/fee split |
| `accrue_management_fee` | Mint exact-time-weighted protocol management shares |
| `complete_protocol_fee_withdrawal` | Record redemption of protocol-owned shares |
| `begin_reconstitution` / `complete_reconstitution` | Pause, execute and commit a signed new composition |
| `begin_resolution` / `record_final_settlement` | Resolve and finalize non-perpetual baskets |
| `publish_perp_eligibility_list` | Publish the Composer-screened Phoenix perpetual market list |
| `onboard_trader_account` | One-time registration of a Phoenix trader account for an execution wallet |
| `complete_phoenix_trade` | Record a vault-delta-verified Phoenix fill and update the composition item |
| `attest_perp_event` | Record an autonomous Phoenix action (ADL, risk-engine cancellation) |
| `set_authorities` / `set_limits` / `set_paused` | Admin security controls |

### Perpetual futures (Phoenix)

A basket may hold Phoenix perpetuals through `PositionKind::Perp`. Three rules
shape the design:

- **Isolated margin only.** Every perpetual item names a Phoenix subaccount
  greater than zero, and no two items may share one. Subaccount 0 is Phoenix's
  cross-margin account, where a loss on one position can consume the collateral
  backing another — which would make a basket share meaningless.
- **A perpetual basket is never mixed** with spot or prediction markets.
  Blending levered and unlevered positions makes the basket's NAV
  undecomposable.
- **Nothing recorded is a quote.** `complete_phoenix_trade` takes figures the
  backend read back from real post-execution Phoenix state. The program
  validates and records; it computes no NAV, no fees and no PnL, and it never
  CPIs into Phoenix.

`entry_mark_price` and `margin_posted` are deliberately **excluded from
`canonical_composition_bytes`**. Settlement rewrites both in place as fills land,
so hashing them would make a basket's `composition_hash` stop matching its
composition after the very first trade. What the hash covers is exactly what the
Composer approved and the program never rewrites: market, direction, leverage,
subaccount and weight.

Because `MAX_SINGLE_SOURCE_WEIGHT_BPS` caps any item at 3000 bps, a fully
perpetual basket has at least four positions.

Basket composition is not supplied directly by an arbitrary creator. The
Composer service computes markets, outcomes and weights off-chain, signs the
canonical composition, and the program verifies that Ed25519 signature plus all
structural constraints. Raw Polymarket depth and volume are not stored
on-chain.

## Backend

Location: `backend/`

| Module | Responsibility |
| --- | --- |
| `accounting` | Integer-only TypeScript parity with the Rust financial math |
| `contract` | Canonical IDL, PDAs, intent/composition encoders and instruction builders |
| `composer` | Deterministic filtering, weighting and signed basket composition |
| `server` | Quote, intent, funding, operation-status and basket APIs |
| `execution` | Durable operation state machine, allocation and attestations |
| `phoenix` | Phoenix perpetual units, sizing, market selection and post-execution verification |
| `deposits` / `withdrawals` | Hybrid bridge, FAK/Jupiter execution and `complete_*` workflows |
| `gateway` | CLOB/Jupiter signing, Polygon transfers and Solana-mainnet fee distribution |
| `jupiter` | Verified token admission, Swap V2 execution and Price V3 marks |
| `indexer` / `nav` | Finalized devnet projections and immutable off-chain NAV snapshots |
| `lifecycle` | Management-fee keeper, reconstitution, resolution and final settlement |
| `ledger` | Append-only double-entry virtual portfolio attribution |
| `wallets` | Sticky, shard-ready basket-to-execution-wallet allocation |
| `reconciliation` | Cross-system checks, dashboard data and alert outbox |
| `resilience` | Provider retry policies and deterministic fault injection |

PostgreSQL is authoritative for backend workflow state and virtual portfolio
attribution. Finalized Solana accounts are authoritative for share accounting.
Polymarket and Solana-mainnet spot balances and fills are independently
reconciled against both.

### Financial API

- `POST /v1/quotes/deposit`
- `POST /v1/quotes/withdrawal`
- `POST /v1/intents/deposit`
- `POST /v1/intents/withdrawal`
- `POST /v1/operations/:id/funding`
- `GET /v1/operations/:id`
- `POST /v1/baskets`

Financial mutations require idempotency keys. Composer and operations routes use
separate bearer authentication.


## Security model

- No private key belongs in the API server, worker environment or database.
- Role-separated Composer, accounting-completion, Polygon-order and
  Solana-settlement keys are accessed through a policy-enforced remote signer.
- CLOB and Jupiter API credentials remain inside the authenticated execution
  gateway.
- Exact signed transaction/order payloads are journaled before broadcast.
- Jupiter-reported fills are checked against finalized Solana-mainnet token
  deltas before they enter the ledger.
- Jupiter signing accepts exactly one settlement signer and an explicit
  top-level program allowlist rooted at the configured aggregator.
- Every external effect has a deterministic idempotency key and immutable
  accounting receipt.
- Finalized bridge and Jupiter source receipts are atomically claimable by only
  one payout split, preventing replay across operations.
- Shared execution wallets permit only one capital-changing operation at a
  time; scaling uses sticky wallet shards.
- Hybrid mode moves real mainnet capital and therefore uses the same allowlists,
  caps and reconciliation controls as a production canary.

