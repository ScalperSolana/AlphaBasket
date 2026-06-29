import { HexString } from "@gear-js/api";
import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

const getEnv = (key: string, fallback?: string): string => {
  const value = process.env[key] || fallback;
  if (!value) {
    throw new Error(`Environment variable ${key} is not set`);
  }
  return value;
};

const getOptionalEnv = (...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
};

const getOptionalHexEnv = (...keys: string[]): HexString | null => {
  const value = getOptionalEnv(...keys);
  if (!value) {
    return null;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      `Environment variable ${keys.join(" or ")} must be a 32-byte hex ActorId`
    );
  }

  return value as HexString;
};

const resolveFromCwd = (relativePath: string): string =>
  path.resolve(process.cwd(), relativePath);

const parseOrigins = (value: string): string[] =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
};

const getNonNegativeBigIntEnv = (key: string, fallback: string): bigint => {
  const value = BigInt(getEnv(key, fallback));
  if (value < 0n) {
    throw new Error(`Environment variable ${key} must be non-negative`);
  }

  return value;
};

export const DAY_MS = 86_400_000n;

export const config = {
  archiveUrl: getEnv("VARA_ARCHIVE_URL"),
  archiveApiKey: getOptionalEnv("SQD_API_KEY"),
  rpcUrl: getEnv("VARA_RPC_URL"),
  rateLimit: Number(getEnv("VARA_RPC_RATE_LIMIT", "20")),
  fromBlock: Number(getEnv("VARA_FROM_BLOCK")),
  gqlPort: Number(process.env.PORT || getEnv("INDEXER_GQL_PORT", "4350")),
  frontendOrigins: parseOrigins(
    getEnv(
      "FRONTEND_URLS",
      "http://localhost:8080,http://127.0.0.1:8080,http://localhost:3000,http://127.0.0.1:3000"
    )
  ),
  graphiqlEnabled:
    process.env.NODE_ENV === "development" ||
    parseBoolean(process.env.INDEXER_GRAPHIQL_ENABLED, false),
  databaseUrl: process.env.DATABASE_URL,
  dbHost: getEnv("DB_HOST", "localhost"),
  dbPort: Number(getEnv("DB_PORT", "5432")),
  dbUser: getEnv("DB_USER", "postgres"),
  dbPass: getEnv("DB_PASS", "postgres"),
  dbName: getEnv("DB_NAME", "polybaskets_indexer"),
  basketMarketProgramId: getEnv("BASKET_MARKET_PROGRAM_ID") as HexString,
  betLaneProgramId: getEnv("BET_LANE_PROGRAM_ID") as HexString,
  betTokenProgramId: getOptionalHexEnv(
    "BET_TOKEN_PROGRAM_ID",
    "VITE_BET_TOKEN_PROGRAM_ID"
  ),
  dailyContestProgramId: getEnv("DAILY_CONTEST_PROGRAM_ID") as HexString,
  basketMarketIdlPath: getEnv(
    "BASKET_MARKET_IDL_PATH",
    resolveFromCwd("../program/polymarket-mirror.idl")
  ),
  betLaneIdlPath: getEnv(
    "BET_LANE_IDL_PATH",
    resolveFromCwd("../bet-lane/client/bet_lane_client.idl")
  ),
  betTokenIdlPath: getEnv(
    "BET_TOKEN_IDL_PATH",
    resolveFromCwd("../bet-token/client/bet_token_client.idl")
  ),
  dailyContestIdlPath: getEnv(
    "DAILY_CONTEST_IDL_PATH",
    resolveFromCwd("../daily-contest/daily-contest.idl")
  ),
  contestDayBoundaryOffsetMs: getNonNegativeBigIntEnv(
    "CONTEST_DAY_BOUNDARY_OFFSET_MS",
    "43200000"
  ),
  settlementGracePeriodMs: BigInt(
    getEnv("CONTEST_GRACE_PERIOD_MS", "1800000")
  ),
  agentPublicIdSalt: getEnv("AGENT_PUBLIC_ID_SALT", "polybaskets-agent-public-id-v1"),
};

export const sourceOfTruth = {
  basketMarket: "basket metadata + settlement finalization day",
  betLane: "CHIP positions and payout formula",
  betToken:
    "CHIP approvals + faucet claims when BET_TOKEN_PROGRAM_ID or VITE_BET_TOKEN_PROGRAM_ID is configured",
  dailyContest: "final settled day result",
  indexer: "projected aggregates only",
} as const;

export const emptyDayPolicy = "settle_no_winner" as const;
