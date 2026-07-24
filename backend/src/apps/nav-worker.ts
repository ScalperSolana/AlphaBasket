import { hostname } from "node:os";

import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import {
  ClobBasketMarkRefreshService,
  NavSnapshotService,
  PostgresBasketAttributedHoldings,
  PostgresBasketHoldingMarkWriter,
  PostgresBasketShareSupply,
  PostgresNavBasketRegistry,
  PostgresNavSnapshotStore,
  UnimplementedStaleOrIlliquidMarkPolicy,
} from "../nav/index.js";
import { PgSqlClient } from "../persistence/index.js";
import {
  ClobRestMarketData,
  JsonHttpClient,
} from "../polymarket/index.js";
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
const clob = new ClobRestMarketData(
  new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 10_000 }),
  { baseUrl: config.polymarket.clobUrl },
);
const marks = new ClobBasketMarkRefreshService(
  holdings,
  clob,
  new PostgresBasketHoldingMarkWriter(sql),
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
})}\n`);
try {
  await worker.run(controller.signal);
} finally {
  await pool.end();
}
