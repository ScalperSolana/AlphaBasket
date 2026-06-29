import { readFileSync } from "node:fs";

const getEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
};

const getPositiveNumberEnv = (name: string, fallback: string): number => {
  const value = Number(getEnv(name, fallback));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid environment variable: ${name}`);
  }

  return value;
};

const getHexEnv = (name: string): `0x${string}` => {
  const value = getEnv(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Invalid ${name}: expected 32-byte hex ActorId`);
  }

  return value as `0x${string}`;
};

const getOptionalEnv = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const normalizeMnemonic = (value: string): string =>
  value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");

const getSharedSettlerSeed = (): string => {
  const seed = getOptionalEnv("SETTLER_SEED");
  const seedFile = getOptionalEnv("SETTLER_SEED_FILE");

  if (seed && seedFile) {
    throw new Error("Set exactly one of SETTLER_SEED or SETTLER_SEED_FILE");
  }

  if (seedFile) {
    const fileValue = readFileSync(seedFile, "utf8").trim();
    if (!fileValue) {
      throw new Error(`SETTLER_SEED_FILE is empty: ${seedFile}`);
    }

    return normalizeMnemonic(fileValue);
  }

  if (seed) {
    return normalizeMnemonic(seed);
  }

  throw new Error("Missing shared bot secret: set SETTLER_SEED or SETTLER_SEED_FILE");
};

export const config = {
  pollIntervalMs: getPositiveNumberEnv("CONTEST_BOT_POLL_INTERVAL_MS", "30000"),
  dailyContestProgramId: getHexEnv("DAILY_CONTEST_PROGRAM_ID"),
  graphqlEndpoint: getEnv("INDEXER_GRAPHQL_ENDPOINT"),
  varaRpcUrl: getEnv("VARA_RPC_URL"),
  settlerSeed: getSharedSettlerSeed(),
};

export const DAY_MS = 86_400_000n;
