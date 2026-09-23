import { hostname } from "node:os";

import {
  AnchorProvider,
  Program,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import { ALPHABASKET_PROGRAM_ID, type PolybasketsEscrow } from "../contract/index.js";
import idl from "../contract/generated/polybaskets_escrow.json" with { type: "json" };
import {
  AnchorLifecycleBasketSource,
  AnchorLifecycleGateway,
  KmsLifecycleTransactionSubmitter,
  ManagementFeeKeeper,
  PostgresDistributedLeaseStore,
  PostgresLifecycleTransactionJournal,
  validateSolanaLifecycleMessage,
} from "../lifecycle/index.js";
import {
  OutboxDispatcher,
  PgSqlClient,
  PostgresOutboxRepository,
} from "../persistence/index.js";
import {
  JsonHttpClient,
  PolymarketPositionsRest,
} from "../polymarket/index.js";
import {
  PolygonPusdBalance,
  assertSolanaRpcCluster,
} from "../runtime/index.js";
import {
  OutboxReconciliationAlertSink,
  PostgresReconciliationSource,
  PostgresReconciliationStore,
  ReconciliationService,
  ReconciliationWebhookAlertDelivery,
  HybridAssetReconciliationRefresher,
  Web3SolanaTokenBalance,
} from "../reconciliation/index.js";
import {
  HttpKeySigner,
  PolicyEnforcedSigner,
  PostgresSignerAuditSink,
  type SignerPolicy,
  type SignerRole,
} from "../signer/index.js";
import {
  PeriodicWorker,
  lifecycleAutomationTasks,
} from "../workers/index.js";

const config = loadBackendConfig();
const required = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`${name} is required to run the lifecycle worker`);
  return value;
};

const remoteSignerUrl = required(config.remoteSigner.url, "REMOTE_SIGNER_URL");
const remoteSignerToken = required(config.remoteSigner.token, "REMOTE_SIGNER_TOKEN");
const backendPublicKey = new PublicKey(required(config.remoteSigner.backendPublicKey, "BACKEND_SIGNER_PUBLIC_KEY"));
const composerPublicKey = new PublicKey(required(config.remoteSigner.composerPublicKey, "COMPOSER_SIGNER_PUBLIC_KEY"));
const configuredProgramId = new PublicKey(config.solana.accounting.programId);
if (!configuredProgramId.equals(ALPHABASKET_PROGRAM_ID)) throw new Error("configured AlphaBasket program ID does not match the generated SDK");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const connection = new Connection(config.solana.accounting.rpcUrl, {
  commitment: "confirmed",
  ...(config.solana.accounting.wsUrl === undefined
    ? {}
    : { wsEndpoint: config.solana.accounting.wsUrl }),
});
const capitalConnection = new Connection(config.solana.capital.rpcUrl, {
  commitment: "confirmed",
  ...(config.solana.capital.wsUrl === undefined
    ? {}
    : { wsEndpoint: config.solana.capital.wsUrl }),
});
await Promise.all([
  assertSolanaRpcCluster(
    connection,
    config.deployment.accountingSolanaCluster,
    "accounting",
  ),
  assertSolanaRpcCluster(
    capitalConnection,
    config.deployment.capitalSolanaCluster,
    "capital",
  ),
]);
type ProviderWallet = ConstructorParameters<typeof AnchorProvider>[1];
const readOnlyWallet: ProviderWallet = {
  publicKey: backendPublicKey,
  signTransaction: async <T extends Transaction | VersionedTransaction>(_transaction: T): Promise<T> => {
    throw new Error("Anchor provider signing is disabled; use the lifecycle KMS submitter");
  },
  signAllTransactions: async <T extends Transaction | VersionedTransaction>(_transactions: T[]): Promise<T[]> => {
    throw new Error("Anchor provider signing is disabled; use the lifecycle KMS submitter");
  },
};
const provider = new AnchorProvider(connection, readOnlyWallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
const program = new Program<PolybasketsEscrow>(idl as PolybasketsEscrow, provider);

const http = new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 });
const keySigner = new HttpKeySigner(http, remoteSignerToken, {
  baseUrl: remoteSignerUrl,
  allowInsecureLocalhost: config.environment !== "production",
});
const policy = (
  role: SignerRole,
  keyReference: string,
  expectedPublicKey: PublicKey,
): SignerPolicy => Object.freeze({
  role,
  keyReference,
  algorithm: "ed25519" as const,
  expectedPublicKey: expectedPublicKey.toBytes(),
  allowedDomains: new Set(["alphabasket:solana-transaction:v1"]),
  allowedActions: new Set(["submit_lifecycle_transaction"]),
  allowedNetworks: new Set([config.deployment.accountingSolanaCluster]),
  maxPayloadBytes: 1_232,
  requireExpiry: true,
  maxExpiryMs: 180_000,
  requiredContext: new Set(["programId", "intentHash"] as const),
  validatePayload: (payload: Uint8Array) => validateSolanaLifecycleMessage(payload, expectedPublicKey, configuredProgramId),
});
const signer = new PolicyEnforcedSigner({
  policies: [
    policy("solana_completion", config.signers.backendKeyId, backendPublicKey),
    policy("composer", config.signers.composerKeyId, composerPublicKey),
  ],
  keySigner,
  auditSink: new PostgresSignerAuditSink(sql),
});
const journal = new PostgresLifecycleTransactionJournal(sql);
const submitter = new KmsLifecycleTransactionSubmitter(connection, signer, journal, {
  feePayer: backendPublicKey,
  signerRoleByPublicKey: new Map([
    [backendPublicKey.toBase58(), "solana_completion" as const],
    [composerPublicKey.toBase58(), "composer" as const],
  ]),
  network: config.deployment.accountingSolanaCluster,
  programId: configuredProgramId,
});
const basketSource = new AnchorLifecycleBasketSource(program);
const gateway = new AnchorLifecycleGateway(program, submitter, basketSource, {
  backendSigner: backendPublicKey,
  composerSigner: composerPublicKey,
});
const ownerId = `${hostname()}:${process.pid.toString(10)}`;
const keeper = new ManagementFeeKeeper(
  basketSource,
  new PostgresDistributedLeaseStore(sql),
  gateway,
  { now: () => new Date() },
  {
    ownerId,
    scanLimit: config.deployment.lifecycleScanLimit,
    minimumAccrualIntervalSeconds: config.deployment.managementFeeMinimumAccrualSeconds,
    leaseDurationMs: 120_000,
  },
);
const outbox = new PostgresOutboxRepository(sql);
const reconciliationSource = new PostgresReconciliationSource(sql);
const reconciliation = new ReconciliationService(
  reconciliationSource,
  new PostgresReconciliationStore(sql),
  new OutboxReconciliationAlertSink(outbox),
  { now: () => new Date() },
  {
    scope: config.operations.reconciliationScope,
    scanLimit: config.deployment.lifecycleScanLimit,
    assetToleranceUnits: config.deployment.reconciliationAssetToleranceUnits,
    maxNavAgeMs: config.deployment.reconciliationMaxNavAgeMs,
    maxPendingOperationAgeMs: config.deployment.reconciliationMaxPendingAgeMs,
  },
);
// The refresher compares ledger attribution against Polygon pUSD balances and
// Polymarket data-API positions, which only exist for the Polymarket venue.
// Venue-aware reconciliation for Jupiter Predict (wallet USDC plus Predict
// position readback) is tracked as follow-up; until then reconciliation runs
// from projections alone on that venue.
const assetRefresher = config.deployment.capitalMode === "live_bridge" &&
  config.prediction.venue === "polymarket"
  ? new HybridAssetReconciliationRefresher(
      sql,
      reconciliationSource,
      new PolygonPusdBalance(
        http,
        required(config.polymarket.polygonRpcUrl, "POLYGON_RPC_URL"),
        required(config.polymarket.pusdTokenAddress, "POLYMARKET_PUSD_TOKEN_ADDRESS"),
      ),
      new PolymarketPositionsRest(http, { baseUrl: config.polymarket.dataUrl }),
      new Web3SolanaTokenBalance(capitalConnection),
      {
        usdcMint: new PublicKey(config.solana.capital.usdcMint),
        fallbackSolanaOwner: new PublicKey(required(
          config.polymarket.solanaSettlementReceiver,
          "SOLANA_SETTLEMENT_RECEIVER",
        )),
      },
    )
  : undefined;
const pagingUrl = config.operations.alertPagingWebhookUrl;
const ticketUrl = config.operations.alertTicketWebhookUrl;
const webhookSecret = config.operations.alertWebhookHmacSecret;
const dispatcher = pagingUrl === undefined || ticketUrl === undefined || webhookSecret === undefined
  ? undefined
  : new OutboxDispatcher(
      outbox,
      new ReconciliationWebhookAlertDelivery(globalThis.fetch, {
        pagingUrl,
        ticketUrl,
        hmacSecret: webhookSecret,
      }),
      {
        ownerId: `${ownerId}:outbox`,
        batchSize: 100,
        leaseDurationMs: 30_000,
        maximumAttempts: 10,
        retryBaseMs: 1_000,
      },
    );
const tasks = lifecycleAutomationTasks(keeper, reconciliation, {
  managementFeeIntervalMs: config.deployment.managementFeeKeeperIntervalMs,
  reconciliationIntervalMs: config.deployment.reconciliationIntervalMs,
  ...(assetRefresher === undefined
    ? {}
    : { beforeReconciliation: () => assetRefresher.runOnce() }),
  ...(dispatcher === undefined ? {} : {
    outbox: dispatcher,
    outboxIntervalMs: config.deployment.outboxIntervalMs,
  }),
});
const worker = new PeriodicWorker(tasks, {
  info: (event, fields) => process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
  error: (event, fields) => process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
});
const controller = new AbortController();
let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ level: "info", event: "lifecycle_worker_stopping", signal })}\n`);
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdout.write(`${JSON.stringify({
  level: "info",
  event: "lifecycle_worker_started",
  ownerId,
  cluster: config.deployment.accountingSolanaCluster,
  tasks: tasks.map((task) => task.name),
})}\n`);
try {
  await worker.run(controller.signal);
} finally {
  await pool.end();
}
