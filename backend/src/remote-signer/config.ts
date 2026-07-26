import { isAbsolute } from "node:path";

import { z } from "zod";

const optionalPositiveInteger = (fallback: number) =>
  z.string().regex(/^[1-9][0-9]*$/u).transform(Number).optional().default(String(fallback));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional()
    .default("development"),
  REMOTE_SIGNER_HOST: z.string().min(1).max(255).optional().default("127.0.0.1"),
  REMOTE_SIGNER_PORT: optionalPositiveInteger(3_003)
    .pipe(z.number().int().min(1).max(65_535)),
  REMOTE_SIGNER_TOKEN: z.string().min(32).max(4_096),
  REMOTE_SIGNER_PROVIDER: z.enum(["development_file"]).optional()
    .default("development_file"),
  REMOTE_SIGNER_KEYRING_FILE: z.string().min(1).max(4_096),
  REMOTE_SIGNER_MAXIMUM_BODY_BYTES: optionalPositiveInteger(16_384)
    .pipe(z.number().int().min(1_024).max(1_048_576)),
  REMOTE_SIGNER_MAXIMUM_CONCURRENT_SIGNATURES: optionalPositiveInteger(16)
    .pipe(z.number().int().min(1).max(1_024)),
}).passthrough();

export interface RemoteSignerConfig {
  readonly environment: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly bearerToken: string;
  readonly provider: "development_file";
  readonly keyringFile: string;
  readonly maximumBodyBytes: number;
  readonly maximumConcurrentSignatures: number;
}

function isLoopback(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" ||
    normalized === "::1" || normalized === "[::1]";
}

export function loadRemoteSignerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RemoteSignerConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new Error(`invalid remote signer configuration: ${parsed.error.message}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === "production") {
    throw new Error(
      "development_file remote signer provider is forbidden in production",
    );
  }
  if (!isLoopback(value.REMOTE_SIGNER_HOST)) {
    throw new Error(
      "development_file remote signer provider may only bind to loopback",
    );
  }
  if (!isAbsolute(value.REMOTE_SIGNER_KEYRING_FILE)) {
    throw new Error("REMOTE_SIGNER_KEYRING_FILE must be an absolute path");
  }
  return Object.freeze({
    environment: value.NODE_ENV,
    host: value.REMOTE_SIGNER_HOST,
    port: value.REMOTE_SIGNER_PORT,
    bearerToken: value.REMOTE_SIGNER_TOKEN,
    provider: value.REMOTE_SIGNER_PROVIDER,
    keyringFile: value.REMOTE_SIGNER_KEYRING_FILE,
    maximumBodyBytes: value.REMOTE_SIGNER_MAXIMUM_BODY_BYTES,
    maximumConcurrentSignatures: value.REMOTE_SIGNER_MAXIMUM_CONCURRENT_SIGNATURES,
  });
}
