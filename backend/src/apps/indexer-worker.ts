import { hostname } from "node:os";

import type { Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import idl from "../contract/generated/polybaskets_escrow.json" with { type: "json" };
import {
  BasketShareSupplyAccountProjector,
  PostgresAccountCursorStore,
  PostgresEventCursorStore,
  PostgresSolanaReadStore,
  SolanaAccountIndexer,
  SolanaEventIndexer,
} from "../indexer/index.js";
import { PostgresBasketShareSupply } from "../nav/index.js";
import { PgSqlClient } from "../persistence/index.js";
import {
  AnchorProgramDecoder,
  Web3SolanaReadRpc,
  assertSolanaRpcCluster,
} from "../runtime/index.js";
import {
  PeriodicWorker,
  indexerTasks,
} from "../workers/index.js";

const config = loadBackendConfig();
const programId = new PublicKey(config.solana.accounting.programId);
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const connection = new Connection(config.solana.accounting.rpcUrl, {
  commitment: "finalized",
  ...(config.solana.accounting.wsUrl === undefined
    ? {}
    : { wsEndpoint: config.solana.accounting.wsUrl }),
});
await assertSolanaRpcCluster(
  connection,
  config.deployment.accountingSolanaCluster,
  "accounting",
);
const rpc = new Web3SolanaReadRpc(connection, "finalized");
const decoder = new AnchorProgramDecoder(programId, idl as Idl);
const readStore = new PostgresSolanaReadStore(sql);
const accountSink = new BasketShareSupplyAccountProjector(
  readStore,
  new PostgresBasketShareSupply(sql),
);
const accounts = new SolanaAccountIndexer(
  rpc,
  decoder,
  accountSink,
  new PostgresAccountCursorStore(sql),
  {
    programId: programId.toBase58(),
    stream: `accounts:${config.deployment.accountingSolanaCluster}:${programId.toBase58()}`,
  },
);
const events = new SolanaEventIndexer(
  rpc,
  decoder,
  readStore,
  new PostgresEventCursorStore(sql),
  {
    address: programId.toBase58(),
    stream: `events:${config.deployment.accountingSolanaCluster}:${programId.toBase58()}`,
    pageSize: config.readPlane.eventPageSize,
    maxPages: config.readPlane.eventMaxPages,
    bootstrapPolicy: config.readPlane.bootstrapPolicy,
  },
);
const worker = new PeriodicWorker(
  indexerTasks(accounts, events, {
    accountIntervalMs: config.readPlane.accountIntervalMs,
    eventIntervalMs: config.readPlane.eventIntervalMs,
  }),
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
  process.stdout.write(`${JSON.stringify({ level: "info", event: "indexer_worker_stopping", signal })}\n`);
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdout.write(`${JSON.stringify({
  level: "info",
  event: "indexer_worker_started",
  ownerId: `${hostname()}:${process.pid.toString(10)}`,
  cluster: config.deployment.accountingSolanaCluster,
  programId: programId.toBase58(),
  bootstrapPolicy: config.readPlane.bootstrapPolicy,
})}\n`);
try {
  await worker.run(controller.signal);
} finally {
  await pool.end();
}
