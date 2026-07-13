# AlphaBasket Backend

This directory is the modular backend for AlphaBasket's real-position architecture.

The design follows three rules:

1. PostgreSQL is authoritative for backend workflows and the virtual portfolio ledger.
2. Solana accounts and immutable settlement receipts are authoritative for share accounting.
3. Polymarket/Polygon balances and fills are independently reconciled against the virtual ledger.

## Commands

```bash
npm install
npm run idl:check
npm test
```

`src/contract/generated` contains the canonical checked-in IDL used by every backend module. Run
`npm run idl:sync` after an Anchor build to update it, then review the resulting diff.

## Module boundaries

- `contract`: canonical IDL, PDAs, signed-message encoders and instruction construction.
- `accounting`: integer-only mirrors of the Rust accounting math.
- `ledger`: append-only double-entry basket attribution.
- `persistence`: PostgreSQL repositories, migrations and transactional outbox.
- `workflows`: Temporal-facing ports; domain code does not import Temporal.
- `signer`: policy-enforced signer interfaces.
- `indexer`: Solana account and event read plane.
- `polymarket`: market-data and CLOB read adapters.
- `nav`: immutable off-chain NAV snapshots.
- `wallets`: sticky basket-to-execution-wallet allocation.
- `composer`: deterministic composition and basket-creation orchestration.
- `quotes`: short-lived NAV quotes and exact Ed25519 user-intent verification.
- `execution`: durable execution state machine, versioned attestations and allocation math.
- `deposits`: finalized Solana funding, Polymarket bridge, FAK buys, idle pUSD and `complete_deposit`.
- `withdrawals`: proportional FAK liquidation, bridge receipt, fee split, user withdrawal and protocol-share redemption.
- `settlement`: fresh-NAV loading and replay-safe Anchor `complete_*` submission.
- `runtime`: independently verifies Solana token deltas and Polygon pUSD credits.

No monetary value is represented as a JavaScript `number`; base-unit amounts use `bigint`.

## Deposit and withdrawal execution

All user-facing financial requests are keyed by an idempotency key and an exact
request hash. External side effects use deterministic operation-derived IDs, and
on-chain settlement receipts make repeated `complete_*` submissions safe.

Deposit execution verifies the user's finalized Solana USDC transfers, follows
the bridge credit into the configured Polymarket execution wallet, performs FAK
buys, leaves unfilled pUSD attributed to the basket, reloads a fresh NAV snapshot,
then calls `complete_deposit` with the user-signed intent and versioned execution
attestation.

Withdrawal execution sells the basket pro rata with FAK orders, includes the
redeemed share of idle pUSD, bridges the realized proceeds to Solana, verifies the
finalized USDC receipt, atomically splits user/creator/protocol amounts, then calls
`complete_withdrawal`. Management-share redemption uses the same liquidation and
bridge path but sends the realized value only to the protocol before calling
`complete_protocol_fee_withdrawal`.

Quotes may remain valid for at most 30 minutes so the signed intent can survive a
normal cross-chain bridge interval. User min-out values, composition version,
nonce and expiry remain bound into the exact signed contract message. Settlement
always reloads a NAV snapshot no more than 15 seconds old.

The PostgreSQL migration `0003_execution_vertical_slices.sql` adds the durable
operation/checkpoint, quote, intent, bridge, CLOB order and settlement journals.
Workers should treat the operation state machine as the workflow source of truth;
provider balances are reconciliation inputs, not basket attribution.
