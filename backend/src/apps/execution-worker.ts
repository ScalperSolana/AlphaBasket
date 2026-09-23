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
import { HttpJupiterExecution } from "../jupiter/index.js";
import {
  FinancialExecutionOperationRunner,
  PostgresExecutionOperationStore,
  PostgresExecutionPortfolioCommit,
  PostgresFakExecutionJournal,
  PostgresFinancialExecutionContext,
  PostgresExecutionWorkQueue,
  type FakExecutionPort,
  type PolymarketBridgePort,
  type PolymarketCreditVerifierPort,
  type PolymarketPusdTransferPort,
} from "../execution/index.js";
import {
  HttpJupiterPredictExecution,
  JupiterPredictMarketData,
  JupiterPredictMarketResolver,
  JupiterPredictRest,
  PostgresPredictMarketLinkStore,
} from "../predict/index.js";
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
  type ClobMarketDataPort,
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
const predictionVenue = config.prediction.venue;
// The Polygon leg exists only for the Polymarket venue; a Solana-native
// deployment must be able to start without any Polygon configuration.
const polygonRpcUrl = predictionVenue === "polymarket"
  ? required(config.polymarket.polygonRpcUrl, "POLYGON_RPC_URL")
  : undefined;
const pusdTokenAddress = predictionVenue === "polymarket"
  ? required(config.polymarket.pusdTokenAddress, "POLYMARKET_PUSD_TOKEN_ADDRESS")
  : undefined;
const solanaSettlementReceiver = required(
  config.polymarket.solanaSettlementReceiver,
  "SOLANA_SETTLEMENT_RECEIVER",
);
const polymarketSolanaChainId = predictionVenue === "polymarket"
  ? required(config.polymarket.solanaChainId, "POLYMARKET_SOLANA_CHAIN_ID")
  : undefined;
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
const venueDisabled = (capability: string): never => {
  throw new Error(
    `${capability} is unavailable: PREDICTION_VENUE is "${predictionVenue}"`,
  );
};
const bridge: PolymarketBridgePort = predictionVenue === "polymarket"
  ? new PolymarketBridgeRest(http, {
      baseUrl: config.polymarket.bridgeUrl,
      ...(config.polymarket.builderCode === undefined
        ? {}
        : { builderCode: config.polymarket.builderCode }),
    })
  : {
      createDepositAddress: () => venueDisabled("the Polymarket deposit bridge"),
      createWithdrawalAddress: () => venueDisabled("the Polymarket withdrawal bridge"),
      getStatus: () => venueDisabled("Polymarket bridge status"),
    };
let venueFak: FakExecutionPort;
if (predictionVenue === "polymarket") {
  venueFak = new ClobFakRestExecution(
    http,
    new HttpClobOrderSigner(http, gatewayOptions),
    { baseUrl: config.polymarket.clobUrl },
  );
} else if (predictionVenue === "jupiter_predict") {
  const predictRest = new JupiterPredictRest(
    new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 15_000 }),
    {
      baseUrl: config.jupiterPredict.url,
      apiKey: required(config.jupiter.apiKey, "JUPITER_API_KEY"),
    },
  );
  venueFak = new HttpJupiterPredictExecution(
    // Predict orders wait for Solana finality plus the venue's fill report,
    // which can exceed the default request budget.
    new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 120_000 }),
    new JupiterPredictMarketResolver(predictRest, new PostgresPredictMarketLinkStore(sql)),
    gatewayOptions,
  );
} else {
  venueFak = { executeFak: () => venueDisabled("prediction execution") };
}
const fak = new PostgresFakExecutionJournal(sql, venueFak);
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
const credit: PolymarketCreditVerifierPort = predictionVenue === "polymarket"
  ? new PolygonPusdCreditVerifier(
      http,
      polygonRpcUrl as string,
      pusdTokenAddress as string,
    )
  : { verifyPusdCredit: () => venueDisabled("Polygon pUSD credit verification") };
const transfer: PolymarketPusdTransferPort = predictionVenue === "polymarket"
  ? new HttpPolymarketPusdTransfer(http, gatewayOptions)
  : { transferPusd: () => venueDisabled("Polygon pUSD transfers") };
const splitter = new HttpSolanaAtomicSplit(http, gatewayOptions);
const jupiter = config.jupiter.enabled
  ? new HttpJupiterExecution(http, gatewayOptions)
  : null;
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
  undefined,
  jupiter,
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
  undefined,
  jupiter,
);
const queue = new PostgresExecutionWorkQueue(sql);
let marketData: ClobMarketDataPort;
if (predictionVenue === "polymarket") {
  marketData = new ClobRestMarketData(http, { baseUrl: config.polymarket.clobUrl });
} else if (predictionVenue === "jupiter_predict") {
  marketData = new JupiterPredictMarketData(
    new JupiterPredictRest(http, {
      baseUrl: config.jupiterPredict.url,
      apiKey: required(config.jupiter.apiKey, "JUPITER_API_KEY"),
    }),
    new PostgresPredictMarketLinkStore(sql),
    { minimumOrderUnits: config.jupiterPredict.minimumOrderUnits },
  );
} else {
  marketData = {
    getOrderBook: () => venueDisabled("prediction market data"),
    getMidpoint: () => venueDisabled("prediction market data"),
  };
}
const runner = new FinancialExecutionOperationRunner(
  new PostgresFinancialExecutionContext(sql, programId),
  new PostgresExecutionPortfolioCommit(sql),
  marketData,
  deposit,
  withdrawal,
  predictionVenue === "polymarket"
    ? new PolygonPusdBalance(http, polygonRpcUrl as string, pusdTokenAddress as string)
    : null,
  {
    capitalMode: config.deployment.capitalMode,
    solanaSettlementReceiver,
    ...(polymarketSolanaChainId === undefined ? {} : { polymarketSolanaChainId }),
    capitalUsdcMint: config.solana.capital.usdcMint,
    predictionVenue: predictionVenue === "disabled" ? "polymarket" : predictionVenue,
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
  predictionVenue,
  accountingCluster: config.deployment.accountingSolanaCluster,
  capitalCluster: config.deployment.capitalSolanaCluster,
})}\n`);
try {
  await worker.runUntil(stopping);
} finally {
  await temporalConnection.close();
  await pool.end();
}
