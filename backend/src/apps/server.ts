import { once } from "node:events";

import {
  AnchorProvider,
  Program,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import {
  BasketCompositionService,
  BasketCreationOrchestrator,
  ContractCompositionMessageEncoder,
} from "../composer/index.js";
import {
  ALPHABASKET_PROGRAM_ID,
  COMPOSITION_DOMAIN,
  type PolybasketsEscrow,
} from "../contract/index.js";
import idl from "../contract/generated/polybaskets_escrow.json" with { type: "json" };
import { PgSqlClient } from "../persistence/index.js";
import {
  JsonHttpClient,
  PolymarketBridgeRest,
} from "../polymarket/index.js";
import { PostgresReconciliationStore } from "../reconciliation/index.js";
import {
  AnchorBasketCreationGateway,
  PolicyComposerSigner,
  RemoteAnchorWallet,
  assertSolanaRpcCluster,
  alphaBasketMessageValidator,
} from "../runtime/index.js";
import {
  HttpKeySigner,
  PolicyEnforcedSigner,
  PostgresSignerAuditSink,
} from "../signer/index.js";
import {
  AlphaBasketApiService,
  LiveBridgeDepositFundingRoute,
  PostgresFinancialRequestStore,
  PostgresQuoteContextStore,
  PrefundedStagingDepositFundingRoute,
  StickyExecutionWalletRoute,
  createBackendHttpServer,
} from "../server/index.js";
import {
  PostgresExecutionWalletRegistry,
  PostgresWalletAssignmentStore,
  RendezvousWalletSelectionStrategy,
  StickyWalletAllocator,
} from "../wallets/index.js";

const config = loadBackendConfig();
const required = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`${name} is required to run the financial API`);
  return value;
};
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const programId = new PublicKey(config.solana.accounting.programId);
if (!programId.equals(ALPHABASKET_PROGRAM_ID)) {
  throw new Error("configured AlphaBasket program ID does not match the generated SDK");
}
const connection = new Connection(config.solana.accounting.rpcUrl, {
  commitment: "confirmed",
  ...(config.solana.accounting.wsUrl === undefined
    ? {}
    : { wsEndpoint: config.solana.accounting.wsUrl }),
});
await assertSolanaRpcCluster(
  connection,
  config.deployment.accountingSolanaCluster,
  "accounting",
);
const http = new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 });
const remoteSignerUrl = required(config.remoteSigner.url, "REMOTE_SIGNER_URL");
const remoteSignerToken = required(config.remoteSigner.token, "REMOTE_SIGNER_TOKEN");
const composerPublicKey = new PublicKey(
  required(config.remoteSigner.composerPublicKey, "COMPOSER_SIGNER_PUBLIC_KEY"),
);
const compositionValidator = (payload: Uint8Array): void => {
  if (
    payload.byteLength <= COMPOSITION_DOMAIN.byteLength ||
    !Buffer.from(payload.subarray(0, COMPOSITION_DOMAIN.byteLength)).equals(COMPOSITION_DOMAIN)
  ) {
    throw new Error("Composer signer payload is not a canonical AlphaBasket composition");
  }
};
const transactionValidator = alphaBasketMessageValidator({
  signer: composerPublicKey,
  programId,
  allowedInstructions: new Set(["create_basket"]),
});
const signer = new PolicyEnforcedSigner({
  policies: [{
    role: "composer",
    keyReference: config.signers.composerKeyId,
    algorithm: "ed25519",
    expectedPublicKey: composerPublicKey.toBytes(),
    allowedDomains: new Set([
      "alphabasket:composition:v1",
      "alphabasket:solana-transaction:v1",
    ]),
    allowedActions: new Set([
      "sign_composition",
      "submit_composer_transaction",
    ]),
    allowedNetworks: new Set([config.deployment.accountingSolanaCluster]),
    maxPayloadBytes: 1_232,
    requireExpiry: true,
    maxExpiryMs: 180_000,
    requiredContext: new Set(["programId", "intentHash"] as const),
    validatePayload: (payload, context) => {
      if (context.domain === "alphabasket:composition:v1") compositionValidator(payload);
      else transactionValidator(payload);
    },
  }],
  keySigner: new HttpKeySigner(http, remoteSignerToken, {
    baseUrl: remoteSignerUrl,
    allowInsecureLocalhost: config.environment !== "production",
  }),
  auditSink: new PostgresSignerAuditSink(sql),
});
const composerWallet = new RemoteAnchorWallet(composerPublicKey, signer, {
  role: "composer",
  domain: "alphabasket:solana-transaction:v1",
  action: "submit_composer_transaction",
  network: config.deployment.accountingSolanaCluster,
  programId,
});
const provider = new AnchorProvider(connection, composerWallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new Program<PolybasketsEscrow>(idl as PolybasketsEscrow, provider);
const basketCreation = new BasketCreationOrchestrator(
  new BasketCompositionService(),
  new ContractCompositionMessageEncoder(),
  new PolicyComposerSigner(signer, {
    network: config.deployment.accountingSolanaCluster,
    programId,
  }),
  new AnchorBasketCreationGateway(program),
  { nowMs: () => BigInt(Date.now()) },
);
const walletRegistry = new PostgresExecutionWalletRegistry(sql);
const walletRoutes = new StickyExecutionWalletRoute(
  new StickyWalletAllocator(
    new PostgresWalletAssignmentStore(sql),
    walletRegistry,
    new RendezvousWalletSelectionStrategy(),
    { nowMs: () => BigInt(Date.now()) },
  ),
  walletRegistry,
);
const fundingRoutes = config.deployment.capitalMode === "live_bridge"
  ? new LiveBridgeDepositFundingRoute(new PolymarketBridgeRest(http, {
      baseUrl: config.polymarket.bridgeUrl,
      ...(config.polymarket.builderCode === undefined ? {} : { builderCode: config.polymarket.builderCode }),
    }))
  : new PrefundedStagingDepositFundingRoute(
      required(
        config.polymarket.stagingSolanaFundingDestination,
        "STAGING_SOLANA_FUNDING_DESTINATION",
      ),
    );
const financialApi = new AlphaBasketApiService(
  new PostgresQuoteContextStore(
    sql,
    programId,
    config.api.maximumNavAgeMs,
  ),
  new PostgresFinancialRequestStore(sql),
  walletRoutes,
  fundingRoutes,
  basketCreation,
);

const server = createBackendHttpServer({
  environment: config.environment,
  version: process.env.npm_package_version ?? "0.1.0",
  readiness: {
    check: async () => {
      await pool.query("SELECT 1");
    },
  },
  api: {
    financial: financialApi,
    composerBearerToken: required(config.api.composerApiToken, "COMPOSER_API_TOKEN"),
    allowedOrigins: new Set(config.api.allowedOrigins),
    maximumBodyBytes: config.api.maximumBodyBytes,
  },
  ...(config.operations.apiToken === undefined ? {} : {
    operations: {
      bearerToken: config.operations.apiToken,
      reconciliationScope: config.operations.reconciliationScope,
      reconciliation: new PostgresReconciliationStore(sql),
    },
  }),
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({ level: "info", message: "shutdown_started", signal })}\n`);

  const forced = setTimeout(() => {
    process.stderr.write(`${JSON.stringify({ level: "error", message: "shutdown_timeout" })}\n`);
    process.exit(1);
  }, config.api.shutdownGraceMs);
  forced.unref();

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
  await pool.end();
  clearTimeout(forced);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => {
      process.exitCode = 0;
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown shutdown error";
      process.stderr.write(`${JSON.stringify({ level: "error", message: "shutdown_failed", error: message })}\n`);
      process.exitCode = 1;
    });
  });
}

server.listen(config.api.port, config.api.host);
await once(server, "listening");
process.stdout.write(`${JSON.stringify({
  level: "info",
  message: "server_started",
  host: config.api.host,
  port: config.api.port,
  environment: config.environment,
})}\n`);
