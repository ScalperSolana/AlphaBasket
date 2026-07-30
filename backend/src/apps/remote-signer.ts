import { once } from "node:events";

import {
  DevelopmentKeyProvider,
  createRemoteSignerHttpServer,
  loadRemoteSignerConfig,
} from "../remote-signer/index.js";

const config = loadRemoteSignerConfig();
const provider = await DevelopmentKeyProvider.load(config.keyringFile);
const server = createRemoteSignerHttpServer({
  provider,
  bearerToken: config.bearerToken,
  maximumBodyBytes: config.maximumBodyBytes,
  maximumConcurrentSignatures: config.maximumConcurrentSignatures,
});

server.listen(config.port, config.host);
await once(server, "listening");
process.stdout.write(`${JSON.stringify({
  level: "info",
  message: "remote_signer_started",
  host: config.host,
  port: config.port,
  provider: config.provider,
  keyCount: provider.identities().length,
})}\n`);

let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`${JSON.stringify({
    level: "info",
    message: "remote_signer_stopping",
    signal,
  })}\n`);
  server.closeIdleConnections();
  server.close((error) => {
    if (error !== undefined) {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        message: "remote_signer_shutdown_failed",
      })}\n`);
      process.exitCode = 1;
    }
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await once(server, "close");
process.stdout.write(`${JSON.stringify({
  level: "info",
  message: "remote_signer_stopped",
})}\n`);
