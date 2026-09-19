import { once } from "node:events";

import { Connection, PublicKey } from "@solana/web3.js";
import { Pool } from "pg";
import {
  createPublicClient,
  getAddress,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";

import { loadBackendConfig } from "../config/index.js";
import {
  ClobOrderGateway,
  ExecutionGatewayService,
  JupiterPredictOrderGateway,
  JupiterSwapGateway,
  PolygonPusdTransferGateway,
  PostgresGatewayRequestStore,
  SolanaUsdcSplitGateway,
  Web3JupiterSwapFinalityVerifier,
  createExecutionGatewayHttpServer,
  solanaCapitalSplitMessageValidator,
  solanaJupiterSwapMessageValidator,
  solanaPredictOrderMessageValidator,
  type PolygonTransferRpcPort,
} from "../gateway/index.js";
import { JupiterPredictRest } from "../predict/index.js";
import { PgSqlClient } from "../persistence/index.js";
import { JsonHttpClient } from "../polymarket/index.js";
import { assertSolanaRpcCluster } from "../runtime/index.js";
import {
  HttpKeySigner,
  PolicyEnforcedSigner,
  PostgresSignerAuditSink,
} from "../signer/index.js";

const config = loadBackendConfig();
const required = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`${name} is required to run the execution gateway`);
  return value;
};
if (
  config.deployment.capitalMode !== "live_bridge" ||
  config.deployment.capitalSolanaCluster !== "mainnet-beta"
) {
  throw new Error("execution gateway requires live bridge capital on Solana mainnet-beta");
}

const gatewayToken = required(config.temporal.executionGatewayToken, "EXECUTION_GATEWAY_TOKEN");
const predictionVenue = config.prediction.venue;
// Polygon key material and RPCs exist only for the Polymarket venue; a
// Solana-native gateway must start without any of it.
const polygonRpcUrl = predictionVenue === "polymarket"
  ? required(config.polymarket.polygonRpcUrl, "POLYGON_RPC_URL")
  : undefined;
const executionWallet = predictionVenue === "polymarket"
  ? getAddress(required(config.polymarket.executionWallet, "POLYMARKET_EXECUTION_WALLET"))
  : undefined;
const pusdToken = predictionVenue === "polymarket"
  ? getAddress(required(config.polymarket.pusdTokenAddress, "POLYMARKET_PUSD_TOKEN_ADDRESS"))
  : undefined;
const settlementOwner = new PublicKey(
  required(config.polymarket.solanaSettlementReceiver, "SOLANA_SETTLEMENT_RECEIVER"),
);
const predictProgramIds = config.jupiterPredict.programIds.map((id) => new PublicKey(id));
if (predictionVenue === "jupiter_predict" && predictProgramIds.length === 0) {
  throw new Error(
    "JUPITER_PREDICT_PROGRAM_IDS is required when PREDICTION_VENUE=jupiter_predict: " +
      "the settlement key only signs transactions whose programs are allowlisted",
  );
}
const usdcMint = new PublicKey(config.solana.capital.usdcMint);
const jupiterAggregatorProgram = new PublicKey(
  config.jupiter.aggregatorProgramId,
);
const remoteSignerUrl = required(config.remoteSigner.url, "REMOTE_SIGNER_URL");
const remoteSignerToken = required(config.remoteSigner.token, "REMOTE_SIGNER_TOKEN");

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const httpClient = new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 15_000 });
const signer = new PolicyEnforcedSigner({
  policies: [
    ...(predictionVenue !== "polymarket" ? [] : [{
      role: "polymarket_order" as const,
      keyReference: config.signers.polymarketKeyId,
      algorithm: "secp256k1" as const,
      allowedDomains: new Set([
        "alphabasket:polymarket-order:v2",
        "alphabasket:polygon-transaction:v1",
      ]),
      allowedActions: new Set(["sign_fak_order", "transfer_pusd"]),
      allowedNetworks: new Set(["polygon-mainnet"]),
      maxPayloadBytes: 32,
      requireExpiry: true,
      maxExpiryMs: 60_000,
      requiredContext: new Set(["intentHash"] as const),
      validatePayload: (payload: Uint8Array) => {
        if (payload.byteLength !== 32) throw new Error("Polygon signer accepts only a 32-byte EIP-712 or transaction digest");
      },
    }]),
    {
      role: "solana_settlement" as const,
      keyReference: config.signers.solanaSettlementKeyId,
      algorithm: "ed25519",
      expectedPublicKey: settlementOwner.toBytes(),
      allowedDomains: new Set(["alphabasket:solana-capital-transaction:v1"]),
      allowedActions: new Set([
        "split_withdrawal_usdc",
        "execute_jupiter_swap",
        "execute_predict_order",
      ]),
      allowedNetworks: new Set(["solana-mainnet-beta"]),
      maxPayloadBytes: 1_232,
      requireExpiry: true,
      maxExpiryMs: 60_000,
      requiredContext: new Set(["intentHash"] as const),
      validatePayload: (payload, context) => {
        const validator = context.action === "execute_jupiter_swap"
          ? solanaJupiterSwapMessageValidator({
              sourceOwner: settlementOwner,
              aggregatorProgramId: jupiterAggregatorProgram,
              maximumMessageBytes: 1_232,
            })
          : context.action === "execute_predict_order"
            ? solanaPredictOrderMessageValidator({
                sourceOwner: settlementOwner,
                allowedProgramIds: predictProgramIds,
                maximumMessageBytes: 1_232,
              })
            : solanaCapitalSplitMessageValidator({
                sourceOwner: settlementOwner,
                usdcMint,
                maximumSplitUnits: config.executionGateway.maximumSplitUnits,
              });
        validator(payload);
      },
    },
  ],
  keySigner: new HttpKeySigner(httpClient, remoteSignerToken, {
    baseUrl: remoteSignerUrl,
    allowInsecureLocalhost: config.environment !== "production",
  }),
  auditSink: new PostgresSignerAuditSink(sql),
});

const polygonClient = predictionVenue !== "polymarket" ? undefined : createPublicClient({
  chain: polygon,
  transport: http(polygonRpcUrl as string, { timeout: 15_000, retryCount: 0 }),
});
const buildPolygonRpc = (client: NonNullable<typeof polygonClient>): PolygonTransferRpcPort => ({
  getTransactionCount: (address) => client.getTransactionCount({
    address,
    blockTag: "pending",
  }),
  estimateFeesPerGas: async () => {
    const fees = await client.estimateFeesPerGas();
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
      throw new Error("Polygon RPC did not return EIP-1559 fees");
    }
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  },
  estimateGas: (request) => client.estimateGas(request),
  getFinalizedReceipt: async (hash) => {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      const head = await client.getBlockNumber();
      if (head < receipt.blockNumber || head - receipt.blockNumber + 1n < 12n) return null;
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  },
  sendRawTransaction: (serializedTransaction) => client.sendRawTransaction({
    serializedTransaction,
  }),
  waitForFinalizedReceipt: async (hash) => {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: 12,
      timeout: 180_000,
    });
    return { status: receipt.status, blockNumber: receipt.blockNumber };
  },
});

const capitalConnection = new Connection(config.solana.capital.rpcUrl, {
  commitment: "confirmed",
  ...(config.solana.capital.wsUrl === undefined
    ? {}
    : { wsEndpoint: config.solana.capital.wsUrl }),
});
await assertSolanaRpcCluster(
  capitalConnection,
  config.deployment.capitalSolanaCluster,
  "capital",
);
const store = new PostgresGatewayRequestStore(sql);
const clob = predictionVenue !== "polymarket" ? undefined : new ClobOrderGateway(store, signer, {
  deploymentMode: config.deployment.mode,
  walletAddress: executionWallet as Address,
  apiKey: required(config.polymarket.clobApiKey, "POLYMARKET_CLOB_API_KEY"),
  apiSecret: required(config.polymarket.clobApiSecret, "POLYMARKET_CLOB_API_SECRET"),
  apiPassphrase: required(
    config.polymarket.clobApiPassphrase,
    "POLYMARKET_CLOB_API_PASSPHRASE",
  ),
  ...(config.polymarket.builderCode === undefined
    ? {}
    : { builderCode: config.polymarket.builderCode as Hex }),
  maximumMakerUnits: config.executionGateway.maximumMakerUnits,
  maximumTakerUnits: config.executionGateway.maximumTakerUnits,
});
const polygonTransfer = polygonClient === undefined
  ? undefined
  : new PolygonPusdTransferGateway(store, signer, buildPolygonRpc(polygonClient), {
      deploymentMode: config.deployment.mode,
      executionWallet: executionWallet as Address,
      pusdToken: pusdToken as Address,
      maximumTransferUnits: config.executionGateway.maximumTransferUnits,
      maximumNetworkFeeWei: config.executionGateway.maximumPolygonFeeWei,
    });
const solanaSplit = new SolanaUsdcSplitGateway(store, signer, capitalConnection, {
  deploymentMode: config.deployment.mode,
  sourceOwner: settlementOwner,
  usdcMint,
  maximumSplitUnits: config.executionGateway.maximumSplitUnits,
  maximumNetworkFeeLamports: config.executionGateway.maximumSolanaFeeLamports,
  expectedDecimals: 6,
});
const jupiter = config.jupiter.enabled
  ? new JupiterSwapGateway(store, signer, httpClient, {
      deploymentMode: config.deployment.mode,
      apiKey: required(config.jupiter.apiKey, "JUPITER_API_KEY"),
      taker: settlementOwner,
      usdcMint,
      aggregatorProgramId: jupiterAggregatorProgram,
      maximumInputUnits: config.executionGateway.maximumJupiterSwapUnits,
      finality: new Web3JupiterSwapFinalityVerifier(capitalConnection),
      baseUrl: config.jupiter.swapUrl,
    })
  : undefined;
const predict = predictionVenue !== "jupiter_predict"
  ? undefined
  : new JupiterPredictOrderGateway(
      store,
      signer,
      new JupiterPredictRest(httpClient, {
        baseUrl: config.jupiterPredict.url,
        apiKey: required(config.jupiter.apiKey, "JUPITER_API_KEY"),
      }),
      capitalConnection,
      {
        deploymentMode: config.deployment.mode,
        taker: settlementOwner,
        usdcMint,
        allowedProgramIds: predictProgramIds,
        maximumOrderUnits: config.executionGateway.maximumPredictOrderUnits,
        minimumOrderUnits: config.jupiterPredict.minimumOrderUnits,
      },
    );
const service = new ExecutionGatewayService(solanaSplit, {
  ...(clob === undefined ? {} : { clob }),
  ...(polygonTransfer === undefined ? {} : { polygon: polygonTransfer }),
  ...(jupiter === undefined ? {} : { jupiter }),
  ...(predict === undefined ? {} : { predict }),
});
const server = createExecutionGatewayHttpServer({
  service,
  bearerToken: gatewayToken,
  maximumBodyBytes: config.executionGateway.maximumBodyBytes,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({
    level: "info",
    message: "execution_gateway_shutdown_started",
    signal,
  })}\n`);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  await pool.end();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => {
      process.exitCode = 0;
    }).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        message: "execution_gateway_shutdown_failed",
        error: error instanceof Error ? error.message : "unknown error",
      })}\n`);
      process.exitCode = 1;
    });
  });
}

server.listen(config.executionGateway.port, config.executionGateway.host);
await once(server, "listening");
process.stdout.write(`${JSON.stringify({
  level: "info",
  message: "execution_gateway_started",
  host: config.executionGateway.host,
  port: config.executionGateway.port,
  capitalCluster: config.deployment.capitalSolanaCluster,
  predictionVenue,
  jupiterSpotEnabled: config.jupiter.enabled,
})}\n`);
