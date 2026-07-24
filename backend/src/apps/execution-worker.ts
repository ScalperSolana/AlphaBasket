import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import {
  AnchorProvider,
  Program,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  NativeConnection,
  Worker,
} from "@temporalio/worker";
import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import {
  ALPHABASKET_PROGRAM_ID,
  type PolybasketsEscrow,
} from "../contract/index.js";
import idl from "../contract/generated/polybaskets_escrow.json" with { type: "json" };
import { DepositWorkflow } from "../deposits/index.js";
import {
  FinancialExecutionOperationRunner,
  PostgresExecutionOperationStore,
  PostgresExecutionPortfolioCommit,
  PostgresFakExecutionJournal,
  PostgresFinancialExecutionContext,
  PostgresExecutionWorkQueue,
} from "../execution/index.js";
import {
  PostgresCanaryUsageStore,
  ProductionCanaryGuard,
} from "../operations/index.js";
import { PgSqlClient } from "../persistence/index.js";
import {
  ClobFakRestExecution,
  ClobRestMarketData,
  HttpClobOrderSigner,
  HttpPolymarketPusdTransfer,
  HttpSolanaAtomicSplit,
  JsonHttpClient,
  PolymarketBridgeRest,
} from "../polymarket/index.js";
import {
  PolygonPusdBalance,
  PolygonPusdCreditVerifier,
  RemoteAnchorWallet,
  Web3SolanaBridgeReceiptVerifier,
  Web3SolanaFundingVerifier,
  assertSolanaRpcCluster,
  alphaBasketMessageValidator,
} from "../runtime/index.js";
import {
  AnchorSettlementGateway,
  PostgresSettlementPricing,
} from "../settlement/index.js";
import {
  HttpKeySigner,
  PolicyEnforcedSigner,
  PostgresSignerAuditSink,
} from "../signer/index.js";
import {
  PostgresWalletOperationLeaseStore,
  WalletExecutionCoordinator,
} from "../wallets/index.js";
import { WithdrawalWorkflow } from "../withdrawals/index.js";
import { FinancialExecutionActivities } from "../workers/index.js";

const config = loadBackendConfig();
const required = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`${name} is required to run the execution worker`);
  return value;
};
if (config.deployment.capitalMode === "mock") {
  throw new Error("execution worker requires CAPITAL_MODE=prefunded_staging or live_bridge");
}
const programId = new PublicKey(config.solana.accounting.programId);
if (!programId.equals(ALPHABASKET_PROGRAM_ID)) {
  throw new Error("configured AlphaBasket program ID does not match the generated SDK");
}
const backendPublicKey = new PublicKey(
  required(config.remoteSigner.backendPublicKey, "BACKEND_SIGNER_PUBLIC_KEY"),
);
const polygonRpcUrl = required(config.polymarket.polygonRpcUrl, "POLYGON_RPC_URL");
const pusdTokenAddress = required(
  config.polymarket.pusdTokenAddress,
  "POLYMARKET_PUSD_TOKEN_ADDRESS",
);
const solanaSettlementReceiver = required(
  config.polymarket.solanaSettlementReceiver,
  "SOLANA_SETTLEMENT_RECEIVER",
);
const polymarketSolanaChainId = required(
  config.polymarket.solanaChainId,
  "POLYMARKET_SOLANA_CHAIN_ID",
);
const gatewayUrl = required(config.temporal.executionGatewayUrl, "EXECUTION_GATEWAY_URL");
const gatewayToken = required(config.temporal.executionGatewayToken, "EXECUTION_GATEWAY_TOKEN");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 30,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const accountingConnection = new Connection(config.solana.accounting.rpcUrl, {
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
    accountingConnection,
    config.deployment.accountingSolanaCluster,
    "accounting",
  ),
  assertSolanaRpcCluster(
    capitalConnection,
    config.deployment.capitalSolanaCluster,
    "capital",
  ),
]);
const http = new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 15_000 });
const remoteSignerUrl = required(config.remoteSigner.url, "REMOTE_SIGNER_URL");
const remoteSignerToken = required(config.remoteSigner.token, "REMOTE_SIGNER_TOKEN");
const transactionValidator = alphaBasketMessageValidator({
  signer: backendPublicKey,
  programId,
  allowedInstructions: new Set([
    "complete_deposit",
    "complete_withdrawal",
    "complete_protocol_fee_withdrawal",
  ]),
});
const signer = new PolicyEnforcedSigner({
  policies: [{
    role: "solana_completion",
    keyReference: config.signers.backendKeyId,
    algorithm: "ed25519",
    expectedPublicKey: backendPublicKey.toBytes(),
    allowedDomains: new Set(["alphabasket:solana-transaction:v1"]),
    allowedActions: new Set(["submit_settlement_transaction"]),
    allowedNetworks: new Set([config.deployment.accountingSolanaCluster]),
    maxPayloadBytes: 1_232,
    requireExpiry: true,
    maxExpiryMs: 180_000,
    requiredContext: new Set(["programId", "intentHash"] as const),
    validatePayload: transactionValidator,
  }],
  keySigner: new HttpKeySigner(http, remoteSignerToken, {
    baseUrl: remoteSignerUrl,
    allowInsecureLocalhost: config.environment !== "production",
  }),
  auditSink: new PostgresSignerAuditSink(sql),
});
const settlementWallet = new RemoteAnchorWallet(backendPublicKey, signer, {
  role: "solana_completion",
  domain: "alphabasket:solana-transaction:v1",
  action: "submit_settlement_transaction",
  network: config.deployment.accountingSolanaCluster,
  programId,
});
const provider = new AnchorProvider(accountingConnection, settlementWallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new Program<PolybasketsEscrow>(idl as PolybasketsEscrow, provider);

const gatewayOptions = {
  baseUrl: gatewayUrl,
  bearerToken: gatewayToken,
  deploymentMode: config.deployment.mode,
  allowInsecureLocalhost: config.environment !== "production",
} as const;
const bridge = new PolymarketBridgeRest(http, {
  baseUrl: config.polymarket.bridgeUrl,
  ...(config.polymarket.builderCode === undefined
    ? {}
    : { builderCode: config.polymarket.builderCode }),
});
const fak = new PostgresFakExecutionJournal(
  sql,
  new ClobFakRestExecution(
    http,
    new HttpClobOrderSigner(http, gatewayOptions),
    { baseUrl: config.polymarket.clobUrl },
  ),
);
const pricing = new PostgresSettlementPricing(sql);
const settlement = new AnchorSettlementGateway(program);
const guard = new ProductionCanaryGuard(
  {
    deploymentMode: config.deployment.mode,
    accountingSolanaCluster: config.deployment.accountingSolanaCluster,
    capitalSolanaCluster: config.deployment.capitalSolanaCluster,
    polymarketChainId: config.polymarket.polygonChainId,
    capitalMode: config.deployment.capitalMode,
    maximumOperationUnits: config.deployment.canaryMaximumOperationUnits,
    maximumDailyUnits: config.deployment.canaryMaximumDailyUnits,
    allowedBasketIds: new Set(config.deployment.canaryAllowedBaskets),
    allowedWalletIds: new Set(config.deployment.canaryAllowedWallets),
  },
  new PostgresCanaryUsageStore(sql),
);
const ownerId = `${hostname()}:${process.pid.toString(10)}:execution`;
const coordinator = new WalletExecutionCoordinator(
  new PostgresWalletOperationLeaseStore(sql),
  ownerId,
  config.temporal.walletLeaseMs,
);
const operationStore = new PostgresExecutionOperationStore(sql);
const credit = new PolygonPusdCreditVerifier(
  http,
  polygonRpcUrl,
  pusdTokenAddress,
);
const transfer = new HttpPolymarketPusdTransfer(http, gatewayOptions);
const splitter = new HttpSolanaAtomicSplit(http, gatewayOptions);
const deposit = new DepositWorkflow(
  operationStore,
  bridge,
  credit,
  new Web3SolanaFundingVerifier(capitalConnection),
  fak,
  pricing,
  settlement,
  guard,
  coordinator,
);
const withdrawal = new WithdrawalWorkflow(
  operationStore,
  fak,
  bridge,
  transfer,
  new Web3SolanaBridgeReceiptVerifier(capitalConnection),
  splitter,
  pricing,
  settlement,
  guard,
  coordinator,
);
const queue = new PostgresExecutionWorkQueue(sql);
const runner = new FinancialExecutionOperationRunner(
  new PostgresFinancialExecutionContext(sql, programId),
  new PostgresExecutionPortfolioCommit(sql),
  new ClobRestMarketData(http, { baseUrl: config.polymarket.clobUrl }),
  deposit,
  withdrawal,
  new PolygonPusdBalance(http, polygonRpcUrl, pusdTokenAddress),
  {
    capitalMode: config.deployment.capitalMode,
    solanaSettlementReceiver,
    polymarketSolanaChainId,
    capitalUsdcMint: config.solana.capital.usdcMint,
  },
);
const activities = new FinancialExecutionActivities(queue, runner);

const typescriptWorkflows = fileURLToPath(
  new URL("../workflows/temporal-workflows.ts", import.meta.url),
);
const javascriptWorkflows = fileURLToPath(
  new URL("../workflows/temporal-workflows.js", import.meta.url),
);
const temporalConnection = await NativeConnection.connect({
  address: config.temporal.address,
});
const worker = await Worker.create({
  connection: temporalConnection,
  namespace: config.temporal.namespace,
  taskQueue: config.temporal.taskQueue,
  workflowsPath: existsSync(typescriptWorkflows)
    ? typescriptWorkflows
    : javascriptWorkflows,
  activities: {
    executeFinancialOperation:
      activities.executeFinancialOperation.bind(activities),
  },
  maxConcurrentActivityTaskExecutions: 8,
  maxConcurrentWorkflowTaskExecutions: 100,
});

let stopWorker: (() => void) | undefined;
const stopping = new Promise<void>((resolve) => {
  stopWorker = resolve;
});
let stoppingStarted = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stoppingStarted) return;
  stoppingStarted = true;
  process.stdout.write(`${JSON.stringify({ level: "info", event: "execution_worker_stopping", signal })}\n`);
  stopWorker?.();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdout.write(`${JSON.stringify({
  level: "info",
  event: "execution_worker_started",
  ownerId,
  taskQueue: config.temporal.taskQueue,
  capitalMode: config.deployment.capitalMode,
  accountingCluster: config.deployment.accountingSolanaCluster,
  capitalCluster: config.deployment.capitalSolanaCluster,
})}\n`);
try {
  await worker.runUntil(stopping);
} finally {
  await temporalConnection.close();
  await pool.end();
}
