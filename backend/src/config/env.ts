import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: nonEmpty,
  TEMPORAL_ADDRESS: nonEmpty.default("127.0.0.1:7233"),
  TEMPORAL_NAMESPACE: nonEmpty.default("default"),
  TEMPORAL_TASK_QUEUE: nonEmpty.default("alphabasket-v2"),
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_WS_URL: z.string().url().optional(),
  ALPHABASKET_PROGRAM_ID: nonEmpty.default("5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm"),
  POLYMARKET_GAMMA_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.string().url().default("https://clob.polymarket.com"),
  POLYGON_CHAIN_ID: z.coerce.number().int().positive().default(137),
  COMPOSER_SIGNER_KEY_ID: nonEmpty,
  BACKEND_SIGNER_KEY_ID: nonEmpty,
  POLYMARKET_SIGNER_KEY_ID: nonEmpty,
  SOLANA_SETTLEMENT_SIGNER_KEY_ID: nonEmpty,
});

export type BackendConfig = Readonly<{
  environment: "development" | "test" | "production";
  databaseUrl: string;
  temporal: Readonly<{ address: string; namespace: string; taskQueue: string }>;
  solana: Readonly<{ rpcUrl: string; wsUrl?: string; programId: string }>;
  polymarket: Readonly<{ gammaUrl: string; clobUrl: string; polygonChainId: number }>;
  signers: Readonly<{
    composerKeyId: string;
    backendKeyId: string;
    polymarketKeyId: string;
    solanaSettlementKeyId: string;
  }>;
}>;

export function loadBackendConfig(source: NodeJS.ProcessEnv = process.env): BackendConfig {
  const value = environmentSchema.parse(source);
  const solana = value.SOLANA_WS_URL === undefined
    ? { rpcUrl: value.SOLANA_RPC_URL, programId: value.ALPHABASKET_PROGRAM_ID }
    : { rpcUrl: value.SOLANA_RPC_URL, wsUrl: value.SOLANA_WS_URL, programId: value.ALPHABASKET_PROGRAM_ID };

  return Object.freeze({
    environment: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    temporal: Object.freeze({
      address: value.TEMPORAL_ADDRESS,
      namespace: value.TEMPORAL_NAMESPACE,
      taskQueue: value.TEMPORAL_TASK_QUEUE,
    }),
    solana: Object.freeze(solana),
    polymarket: Object.freeze({
      gammaUrl: value.POLYMARKET_GAMMA_URL,
      clobUrl: value.POLYMARKET_CLOB_URL,
      polygonChainId: value.POLYGON_CHAIN_ID,
    }),
    signers: Object.freeze({
      composerKeyId: value.COMPOSER_SIGNER_KEY_ID,
      backendKeyId: value.BACKEND_SIGNER_KEY_ID,
      polymarketKeyId: value.POLYMARKET_SIGNER_KEY_ID,
      solanaSettlementKeyId: value.SOLANA_SETTLEMENT_SIGNER_KEY_ID,
    }),
  });
}
