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
  PolygonPusdTransferGateway,
  PostgresGatewayRequestStore,
  SolanaUsdcSplitGateway,
  createExecutionGatewayHttpServer,
  solanaCapitalSplitMessageValidator,
  type PolygonTransferRpcPort,
} from "../gateway/index.js";
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
const polygonRpcUrl = required(config.polymarket.polygonRpcUrl, "POLYGON_RPC_URL");
const executionWallet = getAddress(
  required(config.polymarket.executionWallet, "POLYMARKET_EXECUTION_WALLET"),
);
const pusdToken = getAddress(
  required(config.polymarket.pusdTokenAddress, "POLYMARKET_PUSD_TOKEN_ADDRESS"),
);
const settlementOwner = new PublicKey(
  required(config.polymarket.solanaSettlementReceiver, "SOLANA_SETTLEMENT_RECEIVER"),
);
const usdcMint = new PublicKey(config.solana.capital.usdcMint);
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
    {
      role: "polymarket_order",
      keyReference: config.signers.polymarketKeyId,
      algorithm: "secp256k1",
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
      validatePayload: (payload) => {
        if (payload.byteLength !== 32) throw new Error("Polygon signer accepts only a 32-byte EIP-712 or transaction digest");
      },
    },
    {
      role: "solana_settlement",
      keyReference: config.signers.solanaSettlementKeyId,
      algorithm: "ed25519",
      allowedDomains: new Set(["alphabasket:solana-capital-transaction:v1"]),
      allowedActions: new Set(["split_withdrawal_usdc"]),
      allowedNetworks: new Set(["solana-mainnet-beta"]),
      maxPayloadBytes: 1_232,
      requireExpiry: true,
      maxExpiryMs: 60_000,
      requiredContext: new Set(["intentHash"] as const),
      validatePayload: solanaCapitalSplitMessageValidator({
        sourceOwner: settlementOwner,
        usdcMint,
        maximumSplitUnits: config.executionGateway.maximumSplitUnits,
      }),
    },
  ],
  keySigner: new HttpKeySigner(httpClient, remoteSignerToken, {
    baseUrl: remoteSignerUrl,
    allowInsecureLocalhost: config.environment !== "production",
  }),
  auditSink: new PostgresSignerAuditSink(sql),
});

const polygonClient = createPublicClient({
  chain: polygon,
  transport: http(polygonRpcUrl, { timeout: 15_000, retryCount: 0 }),
});
const polygonRpc: PolygonTransferRpcPort = {
  getTransactionCount: (address) => polygonClient.getTransactionCount({
    address,
    blockTag: "pending",
  }),
  estimateFeesPerGas: async () => {
    const fees = await polygonClient.estimateFeesPerGas();
    if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
      throw new Error("Polygon RPC did not return EIP-1559 fees");
    }
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  },
  estimateGas: (request) => polygonClient.estimateGas(request),
  getFinalizedReceipt: async (hash) => {
    try {
      const receipt = await polygonClient.getTransactionReceipt({ hash });
      const head = await polygonClient.getBlockNumber();
      if (head < receipt.blockNumber || head - receipt.blockNumber + 1n < 12n) return null;
      return { status: receipt.status, blockNumber: receipt.blockNumber };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  },
  sendRawTransaction: (serializedTransaction) => polygonClient.sendRawTransaction({
    serializedTransaction,
  }),
  waitForFinalizedReceipt: async (hash) => {
    const receipt = await polygonClient.waitForTransactionReceipt({
      hash,
      confirmations: 12,
      timeout: 180_000,
    });
    return { status: receipt.status, blockNumber: receipt.blockNumber };
  },
};

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
const clobApiKey = required(config.polymarket.clobApiKey, "POLYMARKET_CLOB_API_KEY");
const clob = new ClobOrderGateway(store, signer, {
  deploymentMode: config.deployment.mode,
  walletAddress: executionWallet,
  apiKey: clobApiKey,
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
const polygonTransfer = new PolygonPusdTransferGateway(store, signer, polygonRpc, {
  deploymentMode: config.deployment.mode,
  executionWallet: executionWallet as Address,
  pusdToken,
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
const service = new ExecutionGatewayService(clob, polygonTransfer, solanaSplit);
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
  polygonChainId: 137,
})}\n`);
