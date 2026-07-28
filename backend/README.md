# AlphaBasket Backend

This directory is the modular backend for AlphaBasket's real-position architecture.

The design follows three rules:

1. PostgreSQL is authoritative for backend workflows and the virtual portfolio ledger.
2. Solana accounts and immutable settlement receipts are authoritative for share accounting.
3. Polymarket/Polygon and Jupiter/Solana-mainnet balances and fills are independently reconciled against the virtual ledger.

## Commands

```bash
npm install
npm run dev
npm run dev:lifecycle
npm run dev:indexer
npm run dev:nav
npm run dev:execution-dispatcher
npm run dev:remote-signer
npm run dev:execution-gateway
npm run dev:execution
npm run signer:keyring:generate -- --output /absolute/path/to/keyring.json
npm run idl:check
npm test
```

For development, copy `.env.example` to `.env` and run `npm run dev`. The
production path is `npm run build && npm start` (or the combined
`npm run start:build`). The HTTP server listens on `127.0.0.1:3001` by default
and exposes `GET /healthz` and database-backed `GET /readyz` probes.

From the repository root, the equivalent commands are `npm run dev:backend`,
`npm run dev:lifecycle:backend`, `npm run start:backend`,
`npm run start:lifecycle:backend`, `npm run dev:indexer:backend`,
`npm run dev:nav:backend`, `npm run dev:execution-dispatcher:backend`,
`npm run dev:remote-signer:backend`, `npm run dev:execution:backend`, and
`npm run migrate:backend`.
The migration process intentionally requires only `DATABASE_URL`; it does not
need RPC endpoints or signer credentials.

Start production-style processes in this order:

1. PostgreSQL and Temporal.
2. `npm run migrate`.
3. `npm run start:indexer:build` and `npm run start:nav:build`.
4. The production KMS/HSM signer, or `npm run start:remote-signer:build` for
   internal loopback testing only.
5. `npm run start:execution-gateway:build`.
6. `npm run start:execution-dispatcher:build` and
   `npm run start:execution:build`.
7. `npm run start:lifecycle:build`.
8. `npm run start:build` for the HTTP API.

The financial API exposes:

- `POST /v1/quotes/deposit`
- `POST /v1/quotes/withdrawal`
- `POST /v1/intents/deposit` (`Idempotency-Key` required)
- `POST /v1/intents/withdrawal` (`Idempotency-Key` required)
- `POST /v1/operations/:id/funding` (`Idempotency-Key` required)
- `GET /v1/operations/:id`
- `POST /v1/baskets` (Composer bearer token required)

Browser origins must be explicitly listed in `API_ALLOWED_ORIGINS`. Financial
request bodies are strictly validated and bounded by `API_MAXIMUM_BODY_BYTES`.

The lifecycle process is a separate daemon. It runs exact-second management-fee
cranks, reconciliation, and (when alert webhooks are configured) transactional
outbox delivery. It requires the remote signer URL, token, and the
configured backend/composer Solana public keys. Signed transaction bytes are
journaled before RPC broadcast and safely replayed across worker crashes.

The execution dispatcher is the PostgreSQL-to-Temporal outbox for financial
operations. It claims work with `SKIP LOCKED`, safely reclaims expired claims,
and treats a Temporal "already started" response as recovery from a crash after
workflow start. The execution worker hosts the deposit/withdrawal activities,
holds an exclusive renewable wallet lease, journals FAK fills, submits replay-
safe on-chain settlement receipts, and commits the resulting virtual portfolio
projection exactly once.

For hybrid internal testing, use:

```text
DEPLOYMENT_MODE=hybrid_devnet
ACCOUNTING_SOLANA_CLUSTER=devnet
ACCOUNTING_SOLANA_RPC_URL=<devnet RPC>
CAPITAL_SOLANA_CLUSTER=mainnet-beta
CAPITAL_SOLANA_RPC_URL=<mainnet RPC>
CAPITAL_MODE=live_bridge
POLYGON_CHAIN_ID=137
```

The two RPC URLs must be different. The accounting connection is used only for
the AlphaBasket program, account/event indexing, management-fee accrual, and
`complete_*` transactions. The capital connection verifies real user funding
and bridge withdrawal receipts and broadcasts the user/creator/platform USDC
split on Solana mainnet. Polymarket trading and pUSD transfers run on Polygon
mainnet. Every public-network process checks the RPC's genesis hash at startup,
so swapping or mislabelling the devnet/mainnet endpoints fails closed. The
devnet program never receives, holds, or distributes funds.

When `JUPITER_SPOT_ENABLED=true`, spot execution uses the same hybrid boundary.
The execution gateway requests an official Jupiter Swap V2 order, journals and
signs the returned versioned transaction through the `solana_settlement` signer,
and submits it on mainnet-beta. Before accepting a fill, it independently loads
the finalized transaction from the capital RPC and reconciles the configured
wallet's input/output SPL-token deltas. Only the resulting accounting
attestation is recorded by `complete_*` on devnet; the program does not invoke
Jupiter by CPI. Native-SOL unwrap routes fail closed because spot custody and
reconciliation currently require an observable SPL-token balance. The
settlement signing policy also requires exactly one signer and permits only the
configured Jupiter aggregator, compute-budget and associated-token programs as
top-level instructions; a Jupiter router/program change requires an explicit
configuration review.

The execution gateway is a separate authenticated service on port `3002` by
default. It holds no raw keys itself: it requests narrowly policy-checked
secp256k1/Ed25519 signatures from the configured remote signer. It journals
the exact signed payload before broadcasting, creates authenticated CLOB v2 FAK
orders, signs Polygon pUSD withdrawal transfers, signs official Jupiter Swap V2
transactions, and constructs the canonical Solana-mainnet `TransferChecked`
distribution transaction. CLOB and Jupiter credentials remain inside this
service and are not exposed to the HTTP API or Temporal workers.

### Remote signer for internal testing

The repository includes a loopback-only development implementation of the same
`POST /v1/sign` boundary used by the backend. It is intended to unblock internal
hybrid testing; it is not a production KMS.

Create the ignored key directory and generate each role-separated key exactly
once:

```bash
mkdir -p .remote-signer
npm run signer:keyring:generate -- \
  --output /absolute/path/to/AlphaBasket/backend/.remote-signer/keyring.json
```

The generator refuses to overwrite an existing keyring, writes it with mode
`0600`, and prints only public identities. Copy the printed values as follows:

- `composer` public key → `COMPOSER_SIGNER_PUBLIC_KEY` and the program's
  `COMPOSER_SIGNER`.
- `solana_completion` public key → `BACKEND_SIGNER_PUBLIC_KEY` and the program's
  `BACKEND_SIGNER`.
- `polymarket_order` address → `POLYMARKET_EXECUTION_WALLET`.
- `solana_settlement` public key → `SOLANA_SETTLEMENT_RECEIVER`.

Then configure:

```text
REMOTE_SIGNER_PROVIDER=development_file
REMOTE_SIGNER_HOST=127.0.0.1
REMOTE_SIGNER_PORT=3003
REMOTE_SIGNER_URL=http://127.0.0.1:3003
REMOTE_SIGNER_KEYRING_FILE=/absolute/path/to/AlphaBasket/backend/.remote-signer/keyring.json
REMOTE_SIGNER_TOKEN=<distinct random secret of at least 32 characters>
```

Generate the bearer token locally, for example with `openssl rand -hex 32`.
It is an AlphaBasket internal-service secret; it does not come from Polymarket
or a cloud provider.

Start it before the execution gateway:

```bash
npm run dev:remote-signer
curl http://127.0.0.1:3003/healthz
```

The development provider refuses production mode, non-loopback binding,
relative paths, symlinked keyrings, and keyrings readable by group or others.
For production, implement the existing `RemoteSignerKeyProvider` interface
using non-exportable KMS/HSM keys and expose the same authenticated API over
HTTPS.

The operations dashboard is available at
`GET /ops/reconciliation/dashboard`; it asks for the bearer token in the browser
and fetches the protected JSON feed without embedding that token in a URL.

`src/contract/generated` contains the canonical checked-in IDL used by every backend module. Run
`npm run idl:sync` after an Anchor build to update it, then review the resulting diff.

## Module boundaries

- `contract`: canonical IDL, PDAs, signed-message encoders and instruction construction.
- `accounting`: integer-only mirrors of the Rust accounting math.
- `ledger`: append-only double-entry basket attribution.
- `persistence`: PostgreSQL repositories, migrations and transactional outbox.
- `workflows`: Temporal-facing ports; domain code does not import Temporal.
- `signer`: policy-enforced signer interfaces.
- `remote-signer`: authenticated signing API and loopback development key provider.
- `indexer`: Solana account and event read plane.
- `polymarket`: market data, CLOB execution, Data API positions, relayer, and CTF redemption encoding.
- `jupiter`: verified token admission, Swap V2 execution and Price V3 marks.
- `nav`: immutable off-chain NAV snapshots.
- `wallets`: sticky basket-to-execution-wallet allocation.
- `composer`: deterministic composition and basket-creation orchestration.
- `quotes`: short-lived NAV quotes and exact Ed25519 user-intent verification.
- `execution`: durable execution state machine, versioned attestations and allocation math.
- `deposits`: finalized mainnet funding, Polymarket FAK buys, Jupiter spot buys, both idle assets and `complete_deposit`.
- `withdrawals`: proportional FAK/Jupiter liquidation, optional bridge receipt, fee split, user withdrawal and protocol-share redemption.
- `settlement`: fresh-NAV loading and replay-safe Anchor `complete_*` submission.
- `runtime`: independently verifies Solana token deltas and Polygon pUSD credits.
- `lifecycle`: leased management-fee keeper, KMS-journaled Solana submission,
  hybrid FAK/Jupiter reconstitution, condition-level CTF redemption, resumable resolution and final settlement.
- `reconciliation`: immutable cross-system snapshots, findings, outbox alerts and authenticated operations reads.
- `resilience`: deterministic fault injection and bounded provider timeout/retry policies.
- `operations`: environment guards and append-only low-value production-canary budgets.
- `workers`: non-overlapping periodic task runner for lifecycle and reconciliation replicas.

All accounting and base-unit amounts use `bigint`. Provider price observations
that arrive as JSON numbers are normalized immediately to six-decimal integer
marks and are never used as floating-point ledger balances.
Every side-effecting workflow holds an exclusive renewable lease for its
execution wallet. Capacity scales by assigning new baskets to additional wallet
shards, never by running concurrent mutations against one wallet.

## Deposit and withdrawal execution

All user-facing financial requests are keyed by an idempotency key and an exact
request hash. External side effects use deterministic operation-derived IDs, and
on-chain settlement receipts make repeated `complete_*` submissions safe.

Deposit execution verifies one finalized Solana-mainnet funding transaction.
Prediction allocation goes to the Polymarket bridge, spot allocation goes to the
mainnet settlement wallet, and the deposit fee goes to the protocol. The worker
performs prediction FAK buys and Jupiter spot buys, retaining unspent pUSD and
USDC under basket attribution, then calls `complete_deposit` on devnet.

Withdrawal execution sells the basket pro rata with prediction FAK orders and
Jupiter spot-to-USDC swaps. It includes the redeemed shares of idle pUSD and
idle USDC, bridges only Polygon proceeds, verifies every capital source,
atomically splits user/creator/protocol USDC on mainnet, and calls
`complete_withdrawal` on devnet. A spot-only withdrawal does not invoke the
Polymarket bridge. Protocol-share redemption follows the same hybrid path.

NAV uses CLOB marks for prediction positions and Jupiter Price V3 for verified
spot mints. Reconciliation compares pUSD, CTF positions, mainnet USDC and SPL
balances with basket attribution. Reconstitution executes both venue types and
persists actual partial fills. It currently does not bridge value between
Polygon and Solana during reconstitution, so a change in the aggregate
venue-level target can remain as an explicit allocation deviation.

Quotes may remain valid for at most 30 minutes so the signed intent can survive a
normal cross-chain bridge interval. User min-out values, composition version,
nonce and expiry remain bound into the exact signed contract message. Settlement
always reloads a NAV snapshot no more than 15 seconds old.

The PostgreSQL migration `0003_execution_vertical_slices.sql` adds the durable
operation/checkpoint, quote, intent, bridge, CLOB order and settlement journals.
Migration `0008_hybrid_jupiter_execution.sql` adds spot holdings, idle USDC,
Jupiter gateway requests, one-time capital-source claims and per-asset
shared-wallet reconciliation. Bridge and Jupiter transaction references cannot
be reused to fund a different withdrawal split.
Workers should treat the operation state machine as the workflow source of truth;
provider balances are reconciliation inputs, not basket attribution.

Lifecycle and production-canary operating procedures are documented in
[`docs/phase-5-6-runbook.md`](docs/phase-5-6-runbook.md).

## Production TODO

The authenticated `POST /v1/baskets` prepared-candidate path is available for
internal testing. Before production, basket sourcing must become authoritative
inside the backend:

1. Fetch eligible markets from Gamma.
2. Run a trusted thematic-relevance and outcome-clarity classifier.
3. Load current price, spread, executable depth and volume directly from CLOB.
4. Pass only backend-produced candidates into deterministic filtering and
   weighting; reject caller-supplied market metrics in production.
5. Test the complete Gamma → classifier → CLOB → Composer signature →
   `create_basket` path against deployed infrastructure.
