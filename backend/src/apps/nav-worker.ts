import { hostname } from "node:os";

import { Pool } from "pg";
import { PublicKey } from "@solana/web3.js";

import { loadBackendConfig } from "../config/index.js";
import {
  ClobBasketMarkRefreshService,
  HybridBasketMarkRefreshService,
  NavSnapshotService,
  PostgresBasketAttributedHoldings,
  PostgresBasketHoldingMarkWriter,
  PostgresBasketShareSupply,
  PostgresNavBasketRegistry,
  PostgresNavSnapshotStore,
  UnimplementedStaleOrIlliquidMarkPolicy,
} from "../nav/index.js";
import { JupiterPriceV3Client } from "../jupiter/index.js";
import { PgSqlClient } from "../persistence/index.js";
import {
  ClobRestMarketData,
  JsonHttpClient,
  type ClobMarketDataPort,
} from "../polymarket/index.js";
import {
  JupiterPredictMarketData,
  JupiterPredictRest,
  PostgresPredictMarketLinkStore,
} from "../predict/index.js";
import {
  NavSnapshotScheduler,
  PeriodicWorker,
  navTasks,
} from "../workers/index.js";

const config = loadBackendConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const holdings = new PostgresBasketAttributedHoldings(sql);
const predictionVenue = config.prediction.venue;
let predictionMarks: ClobMarketDataPort;
if (predictionVenue === "jupiter_predict") {
  predictionMarks = new JupiterPredictMarketData(
    new JupiterPredictRest(
      new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 }),
      {
        baseUrl: config.jupiterPredict.url,
        apiKey: (() => {
          if (config.jupiter.apiKey === undefined) {
            throw new Error("JUPITER_API_KEY is required to price Jupiter Predict holdings");
          }
          return config.jupiter.apiKey;
        })(),
      },
    ),
    new PostgresPredictMarketLinkStore(sql),
    { minimumOrderUnits: config.jupiterPredict.minimumOrderUnits },
  );
} else if (predictionVenue === "polymarket") {
  predictionMarks = new ClobRestMarketData(
    new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 }),
    { baseUrl: config.polymarket.clobUrl },
  );
} else {
  predictionMarks = {
    getOrderBook: () => {
      throw new Error("prediction marks are unavailable: PREDICTION_VENUE is disabled");
    },
    getMidpoint: () => {
      throw new Error("prediction marks are unavailable: PREDICTION_VENUE is disabled");
    },
  };
}
const markWriter = new PostgresBasketHoldingMarkWriter(sql);
const marks = config.jupiter.enabled
  ? new HybridBasketMarkRefreshService(
      holdings,
      predictionMarks,
      new JupiterPriceV3Client(
        new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 }),
        config.jupiter.apiKey as string,
        config.jupiter.priceUrl,
      ),
      new PublicKey(config.solana.capital.usdcMint),
      markWriter,
      { maxBookAgeMs: config.readPlane.navMaxMarkAgeMs },
    )
  : new ClobBasketMarkRefreshService(
      holdings,
      predictionMarks,
      markWriter,
      { maxBookAgeMs: config.readPlane.navMaxMarkAgeMs },
    );
const snapshots = new NavSnapshotService(
  holdings,
  new PostgresBasketShareSupply(sql),
  new PostgresNavSnapshotStore(sql),
  new UnimplementedStaleOrIlliquidMarkPolicy(),
  { nowMs: () => BigInt(Date.now()) },
  { maxMarkAgeMs: config.readPlane.navMaxMarkAgeMs },
);
const scheduler = new NavSnapshotScheduler(
  new PostgresNavBasketRegistry(sql),
  marks,
  snapshots,
  config.readPlane.navScanLimit,
);
const worker = new PeriodicWorker(
  navTasks(scheduler, config.readPlane.navSnapshotIntervalMs),
  {
    info: (event, fields) => process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
    error: (event, fields) => process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
  },
);
const controller = new AbortController();
let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ level: "info", event: "nav_worker_stopping", signal })}\n`);
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdout.write(`${JSON.stringify({
  level: "info",
  event: "nav_worker_started",
  ownerId: `${hostname()}:${process.pid.toString(10)}`,
  intervalMs: config.readPlane.navSnapshotIntervalMs,
  maxMarkAgeMs: config.readPlane.navMaxMarkAgeMs.toString(10),
  jupiterSpotEnabled: config.jupiter.enabled,
  predictionVenue,
})}\n`);
try {
  await worker.run(controller.signal);
} finally {
  await pool.end();
}
