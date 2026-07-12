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

No monetary value is represented as a JavaScript `number`; base-unit amounts use `bigint`.
