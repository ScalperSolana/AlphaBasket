# AlphaBasket Lifecycle, Resilience, and Canary Runbook

## Safety model

The Solana program is an accounting registry. It does not custody USDC or pUSD.
Polymarket execution and bridge transfers remain external side effects, and the
authorized backend completes Solana accounting only after those effects have
been independently verified.

Supported deployment combinations:

| Mode | Accounting Solana | Capital Solana | Polymarket | Capital mode |
| --- | --- | --- | --- | --- |
| `local` | local validator | local/mocked | mocks/read-only | `mock` |
| `hybrid_devnet` | devnet | mainnet-beta | Polygon mainnet | `live_bridge` |
| `production_canary` | mainnet-beta | mainnet-beta | Polygon mainnet | `live_bridge` |
| `production` | mainnet-beta | mainnet-beta | Polygon mainnet | `live_bridge` |

In hybrid mode, the AlphaBasket program and accounting indexer use the devnet
RPC. User funding verification, withdrawal-receipt verification, and
user/creator/platform USDC distribution use a separate mainnet RPC. Polymarket
uses Polygon chain ID 137. Startup fails unless this exact combination is
configured, or when both Solana responsibilities point to the same RPC.
Workers also compare each public RPC's genesis hash to its declared cluster
before performing any read, signature, or capital operation.

No devnet token is represented as collateral. Real USDC travels through the
Polymarket Solana bridge on mainnet, real trades settle as pUSD/positions on
Polygon, and only the corresponding share-accounting completion is recorded on
devnet.

## Deployment order

1. Deploy/upgrade the Solana program and verify its program-data authority.
2. Regenerate and review the checked-in backend IDL.
3. Apply PostgreSQL migrations with `npm run migrate`.
4. Start the finalized Solana devnet account/event indexers.
5. Start NAV snapshots and verify at least one fresh snapshot per active basket.
6. Start the authenticated key-holding execution gateway and verify its KMS/HSM,
   Polygon RPC, Solana mainnet RPC, and PostgreSQL readiness.
7. Start Temporal and execution activity workers.
8. Start lifecycle automation with `npm run start:lifecycle`: management-fee
   keeper, reconciliation, and configured outbox alert delivery.
9. Start the HTTP server and verify `/healthz` and `/readyz`.
10. Enable authenticated operations reads only after setting a random
   `OPERATIONS_API_TOKEN` of at least 32 characters.

The lifecycle worker journals the exact fully signed transaction before RPC
broadcast and signs only approved lifecycle instructions through the
role-separated remote KMS/HSM gateway. Do not put private keys in environment
variables.

## Management-fee keeper

Run the keeper at least hourly. The fee itself is based on exact elapsed seconds,
not the keeper interval. Each basket is protected by a distributed lease so
multiple worker replicas do not submit the same crank concurrently.

The keeper is an optimization, not a correctness dependency. Deposit,
withdrawal, reconstitution, resolution, and final settlement instructions call
the same on-chain lazy-accrual function. NAV snapshots project this exact-second
dilution before calculating the displayed share price.

Alert when:

- a basket has not accrued for more than 36 hours;
- keeper failures repeat for the same basket;
- the account indexer has not observed the keeper transaction at finalized;
- projected fee shares differ from the next finalized Basket account.

## Reconstitution

The durable state sequence is:

```text
created
  -> onchain_started
  -> external_execution_completed
  -> onchain_completed
```

1. Composer builds and signs the exact next composition authorization.
2. Backend calls `begin_reconstitution`; deposits/withdrawals pause for the basket.
3. The idempotent executor sells removed exposure and buys target exposure.
   The first attempt persists the exact market/slippage plan before placing any
   order, so retries cannot recompute different amounts from a later order book.
4. Partial FAK fills are accepted and the residual pUSD remains attributed idle.
5. Backend calls `complete_reconstitution` with the Composer Ed25519 instruction
   immediately before the Anchor instruction.

Every external order uses an operation-derived client order ID. A worker crash
must reload the lifecycle run and replay the provider result rather than create a
new economic action.

## Resolution and final settlement

1. Call `begin_resolution` for a non-perpetual active basket.
2. Redeem each resolved Polymarket condition once per execution wallet through
   the documented collateral adapter and relayer, then attribute winning-token
   payout to each basket from its recorded token quantities.
   Before relay submission, persist the winning token, wallet-wide payout, and
   pUSD balance floor. A crash after Polygon execution can therefore resume from
   the durable preparation without relying on a position row that redemption
   may already have removed from the Data API.
3. Build an immutable final report hash containing all redemption references.
4. Accrue management fees immediately before reading finalized share supply.
5. Call `record_final_settlement`; retry a share-snapshot race with a fresh
   finalized account read, up to the configured bounded attempt count.
6. Verify the basket becomes `redeemable` (or `closed` when supply is zero).

Never mark a lifecycle run complete before the finalized Solana state is visible.

## Reconciliation and alerts

Each immutable reconciliation run compares:

- Basket total shares against the sum of user positions;
- virtual-ledger pUSD attribution against actual wallet attribution;
- immutable NAV against the ledger;
- NAV age;
- age of the oldest incomplete financial operation.

Findings are written to `reconciliation_findings` and published through the
transactional outbox. Read recent runs through:

```text
GET /ops/reconciliation?limit=10
Authorization: Bearer <OPERATIONS_API_TOKEN>
```

Critical findings page an operator. Warning findings create a ticket if they
are emitted. Webhook bodies are HMAC signed and use the outbox event ID as the
delivery idempotency key. Never auto-correct financial balances from a provider
observation; corrections require an explicit, audited ledger entry.

The browser dashboard is served at `/ops/reconciliation/dashboard`. The HTML
contains no reconciliation data; its script requests the bearer token and calls
the protected JSON endpoint.

## Wallet sharding and contention

Basket assignments remain sticky and use rendezvous hashing. Each wallet has a
database-enforced `max_concurrent_operations = 1`. Workers acquire a renewable
operation lease before any CLOB order or pUSD transfer. The exclusive lease is
required because balance-delta verification and basket attribution are unsafe
when two financial operations mutate the same wallet concurrently. Scale by
adding wallet shards, not by increasing per-wallet concurrency.

To add capacity:

1. Insert the wallet as `active` with a conservative concurrency limit.
2. Verify signer policy and pUSD balance.
3. Observe new baskets distributing to the new shard.
4. Existing baskets stay assigned to their current wallet.

To drain a wallet, change its status to `draining`; do not delete assignments.

## Fault injection and provider timeouts

Financial workflows expose fault points immediately after every external side
effect. CI must execute each workflow with one point failing once, restart the
workflow, and assert that provider idempotency keys, order IDs, transfer IDs, and
Solana receipts remain unique.

Provider retries are bounded by both attempt count and per-attempt timeout.
Retry only transport errors, rate limits, and documented transient provider
statuses. Validation errors, signature errors, insufficient funds, and rejected
orders are non-retryable.

## Production canary

The canary guard requires:

- `DEPLOYMENT_MODE=production_canary`;
- `ACCOUNTING_SOLANA_CLUSTER=mainnet-beta`;
- `CAPITAL_SOLANA_CLUSTER=mainnet-beta`;
- `CAPITAL_MODE=live_bridge`;
- Polygon chain ID 137;
- allowlisted basket and wallet;
- per-operation and UTC daily notional limits.

Canary budget reservations are append-only and idempotent by operation ID.
Deposit, withdrawal, protocol-share redemption, and reconstitution workflows
invoke the guard before their first capital-changing side effect.
Begin with one basket, one execution wallet, and the minimum bridgeable amount.
Stop immediately on reconciliation drift, duplicate provider effects, signer
policy denial, stale NAV, or a Solana completion that cannot be reconciled.

For `hybrid_devnet`, the same allowlists and capital limits apply even though
the accounting program is on devnet. Hybrid mode moves real mainnet capital and
must be operated as a production canary.

## Incident controls

1. Pause new API intents.
2. Set the program pause flag if accounting completion must stop.
3. Disable or drain the affected execution wallet.
4. Preserve workflow history, operation checkpoints, provider responses, signer
   audit logs, outbox events, and chain transaction identifiers.
5. Reconcile before retrying. Never issue a replacement transfer merely because
   a provider call timed out.
6. Resume with a low-value canary after the root cause is understood.
