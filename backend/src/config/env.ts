import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const optionalSecret = z.string().trim().min(32).max(512).optional();
const decimalUnits = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).transform((value) => BigInt(value));
const commaSeparated = z.string().default("").transform((value) => Object.freeze(value.split(",").map((item) => item.trim()).filter((item) => item.length > 0)));
const environmentBoolean = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: nonEmpty.default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
  API_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  API_ALLOWED_ORIGINS: commaSeparated,
  API_MAXIMUM_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  API_MAXIMUM_NAV_AGE_MS: z.coerce.bigint().positive().default(30_000n),
  COMPOSER_API_TOKEN: optionalSecret,
  OPERATIONS_API_TOKEN: optionalSecret,
  RECONCILIATION_SCOPE: nonEmpty.default("global"),
  DEPLOYMENT_MODE: z.enum(["local", "hybrid_devnet", "production_canary", "production"]).default("local"),
  ACCOUNTING_SOLANA_CLUSTER: z.enum(["localnet", "devnet", "mainnet-beta"]).default("localnet"),
  CAPITAL_SOLANA_CLUSTER: z.enum(["localnet", "devnet", "mainnet-beta"]).default("localnet"),
  CAPITAL_MODE: z.enum(["mock", "prefunded_staging", "live_bridge"]).default("mock"),
  /**
   * Which venue executes prediction-market composition items.
   *
   * - `jupiter_predict`: Solana-native execution through Jupiter's Prediction
   *   API (Polymarket markets served on Solana, USDC in and out, no Polygon).
   *   With Phoenix for perps and Jupiter for spot, this makes all three asset
   *   classes Solana-native.
   * - `polymarket`: the original Polygon path — CLOB FAK orders, the bridge,
   *   pUSD and the relayer. Kept compiled and selectable rather than deleted:
   *   re-adding roughly 1,400 lines across the 51 files that reference them
   *   costs far more than leaving them dark, and the on-chain
   *   `PositionKind::PredictionMarket` variant stays regardless, since removing
   *   a variant from a deployed program is a migration.
   * - `disabled`: prediction baskets are refused at the quote layer.
   *
   * Defaults to `disabled` when unset so a minimal config stays valid;
   * `POLYMARKET_ENABLED=true` (deprecated) selects `polymarket` for
   * backwards compatibility.
   */
  PREDICTION_VENUE: z.enum(["disabled", "jupiter_predict", "polymarket"]).optional(),
  /** Deprecated: use PREDICTION_VENUE=polymarket instead. */
  POLYMARKET_ENABLED: z.enum(["true", "false"]).default("false"),
  JUPITER_PREDICT_URL: z.string().url().default("https://api.jup.ag/prediction/v1"),
  /**
   * Top-level programs the settlement key may sign in a Predict-built
   * transaction, beyond compute budget and the associated-token program. The
   * Prediction API is in beta and does not publish a stable program id, so the
   * allowlist is explicit configuration: the gateway refuses to start the
   * predict service without it.
   */
  JUPITER_PREDICT_PROGRAM_IDS: commaSeparated,
  /** The API rejects orders below $5; six-decimal units. */
  JUPITER_PREDICT_MINIMUM_ORDER_UNITS: decimalUnits.default("5000000"),
  EXECUTION_GATEWAY_MAXIMUM_PREDICT_ORDER_UNITS: decimalUnits.default("10000000"),
  MANAGEMENT_FEE_KEEPER_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(60_000),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  MANAGEMENT_FEE_MINIMUM_ACCRUAL_SECONDS: z.coerce.bigint().positive().default(3_600n),
  LIFECYCLE_SCAN_LIMIT: z.coerce.number().int().min(1).max(10_000).default(1_000),
  RECONCILIATION_ASSET_TOLERANCE_UNITS: decimalUnits.default("1"),
  RECONCILIATION_MAX_NAV_AGE_MS: z.coerce.bigint().positive().default(120_000n),
  RECONCILIATION_MAX_PENDING_AGE_MS: z.coerce.bigint().positive().default(900_000n),
  CANARY_MAX_OPERATION_UNITS: decimalUnits.default("10000000"),
  CANARY_MAX_DAILY_UNITS: decimalUnits.default("50000000"),
  CANARY_ALLOWED_BASKETS: commaSeparated,
  CANARY_ALLOWED_WALLETS: commaSeparated,
  DATABASE_URL: nonEmpty,
  TEMPORAL_ADDRESS: nonEmpty.default("127.0.0.1:7233"),
  TEMPORAL_NAMESPACE: nonEmpty.default("default"),
  TEMPORAL_TASK_QUEUE: nonEmpty.default("alphabasket"),
  EXECUTION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
  EXECUTION_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
  EXECUTION_DISPATCH_CLAIM_MS: z.coerce.number().int().min(5_000).max(600_000).default(30_000),
  EXECUTION_DISPATCH_RETRY_MS: z.coerce.number().int().min(1_000).max(600_000).default(5_000),
  EXECUTION_WALLET_LEASE_MS: z.coerce.number().int().min(3_000).max(3_600_000).default(120_000),
  EXECUTION_GATEWAY_URL: z.string().url().optional(),
  EXECUTION_GATEWAY_TOKEN: optionalSecret,
  EXECUTION_GATEWAY_HOST: nonEmpty.default("127.0.0.1"),
  EXECUTION_GATEWAY_PORT: z.coerce.number().int().min(1).max(65_535).default(3_002),
  EXECUTION_GATEWAY_MAXIMUM_BODY_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  EXECUTION_GATEWAY_MAXIMUM_MAKER_UNITS: decimalUnits.default("10000000"),
  EXECUTION_GATEWAY_MAXIMUM_TAKER_UNITS: decimalUnits.default("1000000000"),
  EXECUTION_GATEWAY_MAXIMUM_TRANSFER_UNITS: decimalUnits.default("10000000"),
  EXECUTION_GATEWAY_MAXIMUM_SPLIT_UNITS: decimalUnits.default("10000000"),
  EXECUTION_GATEWAY_MAXIMUM_JUPITER_SWAP_UNITS: decimalUnits.default("10000000"),
  EXECUTION_GATEWAY_MAXIMUM_POLYGON_FEE_WEI: decimalUnits.default("100000000000000000"),
  EXECUTION_GATEWAY_MAXIMUM_SOLANA_FEE_LAMPORTS: decimalUnits.default("10000000"),
  INDEXER_ACCOUNT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  INDEXER_EVENT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(2_000),
  INDEXER_EVENT_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
  INDEXER_EVENT_MAX_PAGES: z.coerce.number().int().min(1).max(10_000).default(100),
  INDEXER_BOOTSTRAP_POLICY: z.enum(["backfill", "start-latest"]).default("backfill"),
  NAV_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(10_000),
  NAV_MAX_MARK_AGE_MS: z.coerce.bigint().positive().default(60_000n),
  NAV_SCAN_LIMIT: z.coerce.number().int().min(1).max(10_000).default(1_000),
  ACCOUNTING_SOLANA_RPC_URL: z.string().url(),
  ACCOUNTING_SOLANA_WS_URL: z.string().url().optional(),
  CAPITAL_SOLANA_RPC_URL: z.string().url(),
  CAPITAL_SOLANA_WS_URL: z.string().url().optional(),
  CAPITAL_SOLANA_USDC_MINT: nonEmpty,
  ALPHABASKET_PROGRAM_ID: nonEmpty.default("5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm"),
  POLYMARKET_GAMMA_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_DATA_URL: z.string().url().default("https://data-api.polymarket.com"),
  POLYMARKET_RELAYER_URL: z.string().url().default("https://relayer-v2.polymarket.com"),
  POLYMARKET_BRIDGE_URL: z.string().url().default("https://bridge.polymarket.com"),
  POLYMARKET_BUILDER_CODE: z.string().regex(/^0x[0-9a-fA-F]{64}$/u).optional(),
  POLYGON_RPC_URL: z.string().url().optional(),
  POLYGON_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_PUSD_TOKEN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/u).optional(),
  POLYMARKET_SOLANA_CHAIN_ID: nonEmpty.optional(),
  POLYMARKET_EXECUTION_WALLET: z.string().regex(/^0x[0-9a-fA-F]{40}$/u).optional(),
  POLYMARKET_CLOB_API_KEY: nonEmpty.optional(),
  POLYMARKET_CLOB_API_SECRET: nonEmpty.optional(),
  POLYMARKET_CLOB_API_PASSPHRASE: nonEmpty.optional(),
  STAGING_SOLANA_FUNDING_DESTINATION: nonEmpty.optional(),
  SOLANA_SETTLEMENT_RECEIVER: nonEmpty.optional(),
  JUPITER_SPOT_ENABLED: environmentBoolean.default(false),
  JUPITER_API_KEY: nonEmpty.max(512).optional(),
  JUPITER_TOKENS_URL: z.string().url().default("https://api.jup.ag/tokens/v2"),
  JUPITER_SWAP_URL: z.string().url().default("https://api.jup.ag/swap/v2"),
  JUPITER_PRICE_URL: z.string().url().default("https://api.jup.ag/price/v3"),
  JUPITER_AGGREGATOR_PROGRAM_ID: nonEmpty.default("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  JUPITER_ROUTE_PROBE_UNITS: decimalUnits.default("1000000"),
  JUPITER_XSTOCK_MINTS: commaSeparated,
  REMOTE_SIGNER_URL: z.string().url().optional(),
  REMOTE_SIGNER_TOKEN: optionalSecret,
  BACKEND_SIGNER_PUBLIC_KEY: nonEmpty.optional(),
  COMPOSER_SIGNER_PUBLIC_KEY: nonEmpty.optional(),
  ALERT_PAGING_WEBHOOK_URL: z.string().url().optional(),
  ALERT_TICKET_WEBHOOK_URL: z.string().url().optional(),
  ALERT_WEBHOOK_HMAC_SECRET: optionalSecret,
  COMPOSER_SIGNER_KEY_ID: nonEmpty,
  BACKEND_SIGNER_KEY_ID: nonEmpty,
  POLYMARKET_SIGNER_KEY_ID: nonEmpty,
  SOLANA_SETTLEMENT_SIGNER_KEY_ID: nonEmpty,
});

export type BackendConfig = Readonly<{
  environment: "development" | "test" | "production";
  api: Readonly<{
    host: string;
    port: number;
    shutdownGraceMs: number;
    allowedOrigins: readonly string[];
    maximumBodyBytes: number;
    maximumNavAgeMs: bigint;
    composerApiToken?: string;
  }>;
  operations: Readonly<{
    reconciliationScope: string;
    apiToken?: string;
    alertPagingWebhookUrl?: string;
    alertTicketWebhookUrl?: string;
    alertWebhookHmacSecret?: string;
  }>;
  prediction: Readonly<{
    venue: "disabled" | "jupiter_predict" | "polymarket";
  }>;
  jupiterPredict: Readonly<{
    url: string;
    programIds: readonly string[];
    minimumOrderUnits: bigint;
  }>;
  deployment: Readonly<{
    mode: "local" | "hybrid_devnet" | "production_canary" | "production";
    accountingSolanaCluster: "localnet" | "devnet" | "mainnet-beta";
    capitalSolanaCluster: "localnet" | "devnet" | "mainnet-beta";
    capitalMode: "mock" | "prefunded_staging" | "live_bridge";
    managementFeeKeeperIntervalMs: number;
    reconciliationIntervalMs: number;
    outboxIntervalMs: number;
    managementFeeMinimumAccrualSeconds: bigint;
    lifecycleScanLimit: number;
    reconciliationAssetToleranceUnits: bigint;
    reconciliationMaxNavAgeMs: bigint;
    reconciliationMaxPendingAgeMs: bigint;
    canaryMaximumOperationUnits: bigint;
    canaryMaximumDailyUnits: bigint;
    canaryAllowedBaskets: readonly string[];
    canaryAllowedWallets: readonly string[];
  }>;
  databaseUrl: string;
  temporal: Readonly<{
    address: string;
    namespace: string;
    taskQueue: string;
    dispatchIntervalMs: number;
    dispatchBatchSize: number;
    dispatchClaimMs: number;
    dispatchRetryMs: number;
    walletLeaseMs: number;
    executionGatewayUrl?: string;
    executionGatewayToken?: string;
  }>;
  executionGateway: Readonly<{
    host: string;
    port: number;
    maximumBodyBytes: number;
    maximumMakerUnits: bigint;
    maximumTakerUnits: bigint;
    maximumTransferUnits: bigint;
    maximumSplitUnits: bigint;
    maximumJupiterSwapUnits: bigint;
    maximumPredictOrderUnits: bigint;
    maximumPolygonFeeWei: bigint;
    maximumSolanaFeeLamports: bigint;
  }>;
  readPlane: Readonly<{
    accountIntervalMs: number;
    eventIntervalMs: number;
    eventPageSize: number;
    eventMaxPages: number;
    bootstrapPolicy: "backfill" | "start-latest";
    navSnapshotIntervalMs: number;
    navMaxMarkAgeMs: bigint;
    navScanLimit: number;
  }>;
  solana: Readonly<{
    accounting: Readonly<{ rpcUrl: string; wsUrl?: string; programId: string }>;
    capital: Readonly<{ rpcUrl: string; wsUrl?: string; usdcMint: string }>;
  }>;
  polymarket: Readonly<{
    gammaUrl: string;
    clobUrl: string;
    dataUrl: string;
    relayerUrl: string;
    bridgeUrl: string;
    builderCode?: string;
    polygonRpcUrl?: string;
    polygonChainId: number;
    pusdTokenAddress?: string;
    solanaChainId?: string;
    executionWallet?: string;
    clobApiKey?: string;
    clobApiSecret?: string;
    clobApiPassphrase?: string;
    stagingSolanaFundingDestination?: string;
    solanaSettlementReceiver?: string;
  }>;
  jupiter: Readonly<{
    enabled: boolean;
    tokensUrl: string;
    swapUrl: string;
    priceUrl: string;
    aggregatorProgramId: string;
    routeProbeUnits: bigint;
    xStockMints: readonly string[];
    apiKey?: string;
  }>;
  remoteSigner: Readonly<{
    url?: string;
    token?: string;
    backendPublicKey?: string;
    composerPublicKey?: string;
  }>;
  signers: Readonly<{
    composerKeyId: string;
    backendKeyId: string;
    polymarketKeyId: string;
    solanaSettlementKeyId: string;
  }>;
}>;

export function loadMigrationConfig(source: NodeJS.ProcessEnv = process.env): Readonly<{ databaseUrl: string }> {
  const value = z.object({ DATABASE_URL: nonEmpty }).parse(source);
  return Object.freeze({ databaseUrl: value.DATABASE_URL });
}

export function loadBackendConfig(source: NodeJS.ProcessEnv = process.env): BackendConfig {
  const value = environmentSchema.parse(source);
  // Explicit venue wins; the deprecated boolean maps onto it; otherwise dark.
  const predictionVenue = value.PREDICTION_VENUE ??
    (value.POLYMARKET_ENABLED === "true" ? "polymarket" : "disabled");
  if (value.PREDICTION_VENUE !== undefined && value.PREDICTION_VENUE !== "polymarket" && value.POLYMARKET_ENABLED === "true") {
    throw new Error("POLYMARKET_ENABLED=true conflicts with PREDICTION_VENUE; drop the deprecated flag");
  }
  if (predictionVenue === "jupiter_predict") {
    if (value.SOLANA_SETTLEMENT_RECEIVER === undefined) {
      throw new Error("SOLANA_SETTLEMENT_RECEIVER is required when PREDICTION_VENUE=jupiter_predict");
    }
    if (value.CAPITAL_MODE !== "mock" && value.CAPITAL_SOLANA_CLUSTER !== "mainnet-beta") {
      throw new Error("live Jupiter Predict execution requires capital on Solana mainnet-beta");
    }
    if (!value.JUPITER_PREDICT_URL.startsWith("https://")) {
      throw new Error("JUPITER_PREDICT_URL must use HTTPS");
    }
  }
  if (value.JUPITER_PREDICT_MINIMUM_ORDER_UNITS <= 0n) {
    throw new Error("JUPITER_PREDICT_MINIMUM_ORDER_UNITS must be positive");
  }
  if (value.POLYGON_CHAIN_ID !== 137) throw new Error("POLYGON_CHAIN_ID must be 137 for Polymarket production execution");
  if (
    value.DEPLOYMENT_MODE === "hybrid_devnet" && (
      value.ACCOUNTING_SOLANA_CLUSTER !== "devnet" ||
      value.CAPITAL_SOLANA_CLUSTER !== "mainnet-beta" ||
      value.CAPITAL_MODE !== "live_bridge"
    )
  ) {
    throw new Error(
      "hybrid_devnet requires accounting Solana devnet, capital Solana mainnet-beta, and CAPITAL_MODE=live_bridge",
    );
  }
  if (
    (value.DEPLOYMENT_MODE === "production" || value.DEPLOYMENT_MODE === "production_canary") &&
    (
      value.ACCOUNTING_SOLANA_CLUSTER !== "mainnet-beta" ||
      value.CAPITAL_SOLANA_CLUSTER !== "mainnet-beta"
    )
  ) {
    throw new Error("production deployment modes require accounting and capital Solana mainnet-beta");
  }
  if ((value.DEPLOYMENT_MODE === "production" || value.DEPLOYMENT_MODE === "production_canary") && value.CAPITAL_MODE !== "live_bridge") {
    throw new Error("production deployment modes require CAPITAL_MODE=live_bridge");
  }
  if (value.CAPITAL_MODE === "live_bridge" && value.CAPITAL_SOLANA_CLUSTER !== "mainnet-beta") {
    throw new Error("CAPITAL_MODE=live_bridge requires capital Solana mainnet-beta");
  }
  if (
    value.DEPLOYMENT_MODE === "hybrid_devnet" &&
    value.ACCOUNTING_SOLANA_RPC_URL === value.CAPITAL_SOLANA_RPC_URL
  ) {
    throw new Error("hybrid_devnet accounting and capital Solana RPC URLs must be different");
  }
  if (value.CANARY_MAX_OPERATION_UNITS <= 0n || value.CANARY_MAX_DAILY_UNITS < value.CANARY_MAX_OPERATION_UNITS) {
    throw new Error("canary daily units must be at least the positive per-operation limit");
  }
  const alertValues = [value.ALERT_PAGING_WEBHOOK_URL, value.ALERT_TICKET_WEBHOOK_URL, value.ALERT_WEBHOOK_HMAC_SECRET];
  if (alertValues.some((item) => item !== undefined) && alertValues.some((item) => item === undefined)) {
    throw new Error("paging URL, ticket URL and alert HMAC secret must be configured together");
  }
  const remoteSignerValues = [value.REMOTE_SIGNER_URL, value.REMOTE_SIGNER_TOKEN, value.BACKEND_SIGNER_PUBLIC_KEY, value.COMPOSER_SIGNER_PUBLIC_KEY];
  if (remoteSignerValues.some((item) => item !== undefined) && remoteSignerValues.some((item) => item === undefined)) {
    throw new Error("remote signer URL, token and both Solana public keys must be configured together");
  }
  if ((value.EXECUTION_GATEWAY_URL === undefined) !== (value.EXECUTION_GATEWAY_TOKEN === undefined)) {
    throw new Error("execution gateway URL and token must be configured together");
  }
  const clobCredentials = [
    value.POLYMARKET_CLOB_API_KEY,
    value.POLYMARKET_CLOB_API_SECRET,
    value.POLYMARKET_CLOB_API_PASSPHRASE,
  ];
  if (clobCredentials.some((item) => item !== undefined) && clobCredentials.some((item) => item === undefined)) {
    throw new Error("Polymarket CLOB API key, secret and passphrase must be configured together");
  }
  if (value.JUPITER_SPOT_ENABLED) {
    if (value.CAPITAL_SOLANA_CLUSTER !== "mainnet-beta") {
      throw new Error(
        "live Jupiter spot execution requires capital on Solana mainnet-beta",
      );
    }
    if (value.JUPITER_API_KEY === undefined) {
      throw new Error("JUPITER_API_KEY is required when Jupiter spot execution is enabled");
    }
    if (value.SOLANA_SETTLEMENT_RECEIVER === undefined) {
      throw new Error("SOLANA_SETTLEMENT_RECEIVER is required when Jupiter spot execution is enabled");
    }
  }
  if (value.JUPITER_ROUTE_PROBE_UNITS <= 0n) {
    throw new Error("JUPITER_ROUTE_PROBE_UNITS must be positive");
  }
  const gatewayLimits = [
    value.EXECUTION_GATEWAY_MAXIMUM_MAKER_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_TAKER_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_TRANSFER_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_SPLIT_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_JUPITER_SWAP_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_PREDICT_ORDER_UNITS,
    value.EXECUTION_GATEWAY_MAXIMUM_POLYGON_FEE_WEI,
    value.EXECUTION_GATEWAY_MAXIMUM_SOLANA_FEE_LAMPORTS,
  ];
  if (gatewayLimits.some((item) => item <= 0n)) {
    throw new Error("execution gateway amount and fee limits must be positive");
  }
  const accountingSolana = value.ACCOUNTING_SOLANA_WS_URL === undefined
    ? { rpcUrl: value.ACCOUNTING_SOLANA_RPC_URL, programId: value.ALPHABASKET_PROGRAM_ID }
    : {
        rpcUrl: value.ACCOUNTING_SOLANA_RPC_URL,
        wsUrl: value.ACCOUNTING_SOLANA_WS_URL,
        programId: value.ALPHABASKET_PROGRAM_ID,
      };
  const capitalSolana = value.CAPITAL_SOLANA_WS_URL === undefined
    ? { rpcUrl: value.CAPITAL_SOLANA_RPC_URL, usdcMint: value.CAPITAL_SOLANA_USDC_MINT }
    : {
        rpcUrl: value.CAPITAL_SOLANA_RPC_URL,
        wsUrl: value.CAPITAL_SOLANA_WS_URL,
        usdcMint: value.CAPITAL_SOLANA_USDC_MINT,
      };

  return Object.freeze({
    environment: value.NODE_ENV,
    prediction: Object.freeze({ venue: predictionVenue }),
    jupiterPredict: Object.freeze({
      url: value.JUPITER_PREDICT_URL,
      programIds: value.JUPITER_PREDICT_PROGRAM_IDS,
      minimumOrderUnits: value.JUPITER_PREDICT_MINIMUM_ORDER_UNITS,
    }),
    api: Object.freeze({
      host: value.API_HOST,
      port: value.API_PORT,
      shutdownGraceMs: value.API_SHUTDOWN_GRACE_MS,
      allowedOrigins: value.API_ALLOWED_ORIGINS,
      maximumBodyBytes: value.API_MAXIMUM_BODY_BYTES,
      maximumNavAgeMs: value.API_MAXIMUM_NAV_AGE_MS,
      ...(value.COMPOSER_API_TOKEN === undefined ? {} : { composerApiToken: value.COMPOSER_API_TOKEN }),
    }),
    operations: Object.freeze({
      reconciliationScope: value.RECONCILIATION_SCOPE,
      ...(value.OPERATIONS_API_TOKEN === undefined ? {} : { apiToken: value.OPERATIONS_API_TOKEN }),
      ...(value.ALERT_PAGING_WEBHOOK_URL === undefined ? {} : {
        alertPagingWebhookUrl: value.ALERT_PAGING_WEBHOOK_URL,
        alertTicketWebhookUrl: value.ALERT_TICKET_WEBHOOK_URL as string,
        alertWebhookHmacSecret: value.ALERT_WEBHOOK_HMAC_SECRET as string,
      }),
    }),
    deployment: Object.freeze({
      mode: value.DEPLOYMENT_MODE,
      accountingSolanaCluster: value.ACCOUNTING_SOLANA_CLUSTER,
      capitalSolanaCluster: value.CAPITAL_SOLANA_CLUSTER,
      capitalMode: value.CAPITAL_MODE,
      managementFeeKeeperIntervalMs: value.MANAGEMENT_FEE_KEEPER_INTERVAL_MS,
      reconciliationIntervalMs: value.RECONCILIATION_INTERVAL_MS,
      outboxIntervalMs: value.OUTBOX_INTERVAL_MS,
      managementFeeMinimumAccrualSeconds: value.MANAGEMENT_FEE_MINIMUM_ACCRUAL_SECONDS,
      lifecycleScanLimit: value.LIFECYCLE_SCAN_LIMIT,
      reconciliationAssetToleranceUnits: value.RECONCILIATION_ASSET_TOLERANCE_UNITS,
      reconciliationMaxNavAgeMs: value.RECONCILIATION_MAX_NAV_AGE_MS,
      reconciliationMaxPendingAgeMs: value.RECONCILIATION_MAX_PENDING_AGE_MS,
      canaryMaximumOperationUnits: value.CANARY_MAX_OPERATION_UNITS,
      canaryMaximumDailyUnits: value.CANARY_MAX_DAILY_UNITS,
      canaryAllowedBaskets: value.CANARY_ALLOWED_BASKETS,
      canaryAllowedWallets: value.CANARY_ALLOWED_WALLETS,
    }),
    databaseUrl: value.DATABASE_URL,
    temporal: Object.freeze({
      address: value.TEMPORAL_ADDRESS,
      namespace: value.TEMPORAL_NAMESPACE,
      taskQueue: value.TEMPORAL_TASK_QUEUE,
      dispatchIntervalMs: value.EXECUTION_DISPATCH_INTERVAL_MS,
      dispatchBatchSize: value.EXECUTION_DISPATCH_BATCH_SIZE,
      dispatchClaimMs: value.EXECUTION_DISPATCH_CLAIM_MS,
      dispatchRetryMs: value.EXECUTION_DISPATCH_RETRY_MS,
      walletLeaseMs: value.EXECUTION_WALLET_LEASE_MS,
      ...(value.EXECUTION_GATEWAY_URL === undefined ? {} : {
        executionGatewayUrl: value.EXECUTION_GATEWAY_URL,
        executionGatewayToken: value.EXECUTION_GATEWAY_TOKEN as string,
      }),
    }),
    executionGateway: Object.freeze({
      host: value.EXECUTION_GATEWAY_HOST,
      port: value.EXECUTION_GATEWAY_PORT,
      maximumBodyBytes: value.EXECUTION_GATEWAY_MAXIMUM_BODY_BYTES,
      maximumMakerUnits: value.EXECUTION_GATEWAY_MAXIMUM_MAKER_UNITS,
      maximumTakerUnits: value.EXECUTION_GATEWAY_MAXIMUM_TAKER_UNITS,
      maximumTransferUnits: value.EXECUTION_GATEWAY_MAXIMUM_TRANSFER_UNITS,
      maximumSplitUnits: value.EXECUTION_GATEWAY_MAXIMUM_SPLIT_UNITS,
      maximumJupiterSwapUnits: value.EXECUTION_GATEWAY_MAXIMUM_JUPITER_SWAP_UNITS,
      maximumPredictOrderUnits: value.EXECUTION_GATEWAY_MAXIMUM_PREDICT_ORDER_UNITS,
      maximumPolygonFeeWei: value.EXECUTION_GATEWAY_MAXIMUM_POLYGON_FEE_WEI,
      maximumSolanaFeeLamports: value.EXECUTION_GATEWAY_MAXIMUM_SOLANA_FEE_LAMPORTS,
    }),
    readPlane: Object.freeze({
      accountIntervalMs: value.INDEXER_ACCOUNT_INTERVAL_MS,
      eventIntervalMs: value.INDEXER_EVENT_INTERVAL_MS,
      eventPageSize: value.INDEXER_EVENT_PAGE_SIZE,
      eventMaxPages: value.INDEXER_EVENT_MAX_PAGES,
      bootstrapPolicy: value.INDEXER_BOOTSTRAP_POLICY,
      navSnapshotIntervalMs: value.NAV_SNAPSHOT_INTERVAL_MS,
      navMaxMarkAgeMs: value.NAV_MAX_MARK_AGE_MS,
      navScanLimit: value.NAV_SCAN_LIMIT,
    }),
    solana: Object.freeze({
      accounting: Object.freeze(accountingSolana),
      capital: Object.freeze(capitalSolana),
    }),
    polymarket: Object.freeze({
      gammaUrl: value.POLYMARKET_GAMMA_URL,
      clobUrl: value.POLYMARKET_CLOB_URL,
      dataUrl: value.POLYMARKET_DATA_URL,
      relayerUrl: value.POLYMARKET_RELAYER_URL,
      bridgeUrl: value.POLYMARKET_BRIDGE_URL,
      ...(value.POLYMARKET_BUILDER_CODE === undefined ? {} : { builderCode: value.POLYMARKET_BUILDER_CODE }),
      ...(value.POLYGON_RPC_URL === undefined ? {} : { polygonRpcUrl: value.POLYGON_RPC_URL }),
      polygonChainId: value.POLYGON_CHAIN_ID,
      ...(value.POLYMARKET_PUSD_TOKEN_ADDRESS === undefined ? {} : {
        pusdTokenAddress: value.POLYMARKET_PUSD_TOKEN_ADDRESS.toLowerCase(),
      }),
      ...(value.POLYMARKET_SOLANA_CHAIN_ID === undefined ? {} : {
        solanaChainId: value.POLYMARKET_SOLANA_CHAIN_ID,
      }),
      ...(value.POLYMARKET_EXECUTION_WALLET === undefined ? {} : { executionWallet: value.POLYMARKET_EXECUTION_WALLET.toLowerCase() }),
      ...(value.POLYMARKET_CLOB_API_KEY === undefined ? {} : {
        clobApiKey: value.POLYMARKET_CLOB_API_KEY,
        clobApiSecret: value.POLYMARKET_CLOB_API_SECRET as string,
        clobApiPassphrase: value.POLYMARKET_CLOB_API_PASSPHRASE as string,
      }),
      ...(value.STAGING_SOLANA_FUNDING_DESTINATION === undefined ? {} : {
        stagingSolanaFundingDestination: value.STAGING_SOLANA_FUNDING_DESTINATION,
      }),
      ...(value.SOLANA_SETTLEMENT_RECEIVER === undefined ? {} : {
        solanaSettlementReceiver: value.SOLANA_SETTLEMENT_RECEIVER,
      }),
    }),
    jupiter: Object.freeze({
      enabled: value.JUPITER_SPOT_ENABLED,
      tokensUrl: value.JUPITER_TOKENS_URL,
      swapUrl: value.JUPITER_SWAP_URL,
      priceUrl: value.JUPITER_PRICE_URL,
      aggregatorProgramId: value.JUPITER_AGGREGATOR_PROGRAM_ID,
      routeProbeUnits: value.JUPITER_ROUTE_PROBE_UNITS,
      xStockMints: value.JUPITER_XSTOCK_MINTS,
      ...(value.JUPITER_API_KEY === undefined ? {} : {
        apiKey: value.JUPITER_API_KEY,
      }),
    }),
    remoteSigner: Object.freeze({
      ...(value.REMOTE_SIGNER_URL === undefined ? {} : { url: value.REMOTE_SIGNER_URL }),
      ...(value.REMOTE_SIGNER_TOKEN === undefined ? {} : { token: value.REMOTE_SIGNER_TOKEN }),
      ...(value.BACKEND_SIGNER_PUBLIC_KEY === undefined ? {} : { backendPublicKey: value.BACKEND_SIGNER_PUBLIC_KEY }),
      ...(value.COMPOSER_SIGNER_PUBLIC_KEY === undefined ? {} : { composerPublicKey: value.COMPOSER_SIGNER_PUBLIC_KEY }),
    }),
    signers: Object.freeze({
      composerKeyId: value.COMPOSER_SIGNER_KEY_ID,
      backendKeyId: value.BACKEND_SIGNER_KEY_ID,
      polymarketKeyId: value.POLYMARKET_SIGNER_KEY_ID,
      solanaSettlementKeyId: value.SOLANA_SETTLEMENT_SIGNER_KEY_ID,
    }),
  });
}
