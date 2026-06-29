import {
  BlockHeader as _BlockHeader,
  DataHandlerContext,
  SubstrateBatchProcessor,
  SubstrateBatchProcessorFields,
  Event as _Event,
  Call as _Call,
  Extrinsic as _Extrinsic,
} from "@subsquid/substrate-processor";
import { Store } from "@subsquid/typeorm-store";
import { hostname } from "node:os";
import { config } from "./config";

if (!config.archiveApiKey) {
  throw new Error("Environment variable SQD_API_KEY is not set");
}

export const processor = new SubstrateBatchProcessor()
  .setGateway({ url: config.archiveUrl, apiKey: config.archiveApiKey })
  .setRpcEndpoint({
    url: config.rpcUrl,
    rateLimit: config.rateLimit,
    headers: {
      "User-Agent": hostname(),
    },
  })
  .setBlockRange({ from: config.fromBlock })
  .setFields({
    event: {
      args: true,
      extrinsic: true,
      call: true,
    },
    extrinsic: {
      hash: true,
      fee: true,
      signature: true,
    },
    call: {
      args: true,
    },
    block: {
      timestamp: true,
    },
  });

export type Fields = SubstrateBatchProcessorFields<typeof processor>;
export type BlockHeader = _BlockHeader<Fields> & { timestamp: number };
export type Event = _Event<Fields>;
export type Call = _Call<Fields>;
export type Extrinsic = _Extrinsic<Fields>;
export type ProcessorContext = DataHandlerContext<Store, Fields>;
