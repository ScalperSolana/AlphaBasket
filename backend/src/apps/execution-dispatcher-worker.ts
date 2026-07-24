import { hostname } from "node:os";

import {
  Client as TemporalClient,
  Connection as TemporalConnection,
} from "@temporalio/client";
import { Pool } from "pg";

import { loadBackendConfig } from "../config/index.js";
import { PostgresExecutionWorkQueue } from "../execution/index.js";
import { PgSqlClient } from "../persistence/index.js";
import { TemporalWorkflowClientAdapter } from "../runtime/index.js";
import {
  ExecutionDispatcher,
  PeriodicWorker,
} from "../workers/index.js";

const config = loadBackendConfig();
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
const sql = new PgSqlClient(pool);
const temporalConnection = await TemporalConnection.connect({
  address: config.temporal.address,
});
const temporal = new TemporalClient({
  connection: temporalConnection,
  namespace: config.temporal.namespace,
});
const ownerId = `${hostname()}:${process.pid.toString(10)}:execution-dispatch`;
const dispatcher = new ExecutionDispatcher(
  new PostgresExecutionWorkQueue(sql),
  new TemporalWorkflowClientAdapter(temporal.workflow),
  {
    ownerId,
    taskQueue: config.temporal.taskQueue,
    batchSize: config.temporal.dispatchBatchSize,
    claimDurationMs: config.temporal.dispatchClaimMs,
    retryDelayMs: config.temporal.dispatchRetryMs,
  },
);
const worker = new PeriodicWorker(
  [{
    name: "execution-operation-dispatch-and-resume",
    intervalMs: config.temporal.dispatchIntervalMs,
    run: async () => {
      await dispatcher.runOnce();
    },
  }],
  {
    info: (event, fields) =>
      process.stdout.write(`${JSON.stringify({ level: "info", event, ...fields })}\n`),
    error: (event, fields) =>
      process.stderr.write(`${JSON.stringify({ level: "error", event, ...fields })}\n`),
  },
);
const controller = new AbortController();
let stopping = false;
const stop = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({ level: "info", event: "execution_dispatcher_stopping", signal })}\n`);
  controller.abort();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.stdout.write(`${JSON.stringify({
  level: "info",
  event: "execution_dispatcher_started",
  ownerId,
  taskQueue: config.temporal.taskQueue,
})}\n`);
try {
  await worker.run(controller.signal);
} finally {
  await temporalConnection.close();
  await pool.end();
}
