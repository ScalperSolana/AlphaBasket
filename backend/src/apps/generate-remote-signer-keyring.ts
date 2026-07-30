import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import bs58 from "bs58";
import { hexToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ED25519_PUBLIC_KEY_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const KEY_REFERENCE_PATTERN = /^[A-Za-z0-9_.:/-]{1,512}$/u;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function keyReference(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  if (!KEY_REFERENCE_PATTERN.test(value)) {
    throw new Error(`${name} is not a valid remote signer key reference`);
  }
  return value;
}

function createEd25519Key(keyReferenceValue: string) {
  const pair = generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" });
  if (
    !Buffer.isBuffer(privateDer) ||
    !Buffer.isBuffer(publicDer) ||
    publicDer.byteLength !== ED25519_PUBLIC_KEY_DER_PREFIX.byteLength + 32 ||
    !publicDer.subarray(0, ED25519_PUBLIC_KEY_DER_PREFIX.byteLength)
      .equals(ED25519_PUBLIC_KEY_DER_PREFIX)
  ) {
    throw new Error("failed to generate an Ed25519 key");
  }
  const rawPublicKey = publicDer.subarray(ED25519_PUBLIC_KEY_DER_PREFIX.byteLength);
  return {
    stored: {
      keyReference: keyReferenceValue,
      algorithm: "ed25519" as const,
      privateKeyPkcs8Base64: privateDer.toString("base64"),
    },
    publicIdentity: {
      keyReference: keyReferenceValue,
      algorithm: "ed25519" as const,
      publicKeyBase58: bs58.encode(rawPublicKey),
    },
  };
}

const output = argument("--output");
if (!isAbsolute(output)) throw new Error("--output must be an absolute path");

const references = {
  composer: keyReference("COMPOSER_SIGNER_KEY_ID", "alphabasket-composer-dev"),
  backend: keyReference("BACKEND_SIGNER_KEY_ID", "alphabasket-settlement-dev"),
  polymarket: keyReference(
    "POLYMARKET_SIGNER_KEY_ID",
    "alphabasket-polymarket-dev",
  ),
  solanaSettlement: keyReference(
    "SOLANA_SETTLEMENT_SIGNER_KEY_ID",
    "alphabasket-usdc-dev",
  ),
};
if (new Set(Object.values(references)).size !== Object.values(references).length) {
  throw new Error("remote signer key references must be unique");
}

const composer = createEd25519Key(references.composer);
const backend = createEd25519Key(references.backend);
const solanaSettlement = createEd25519Key(references.solanaSettlement);
const polygonPrivateKey = generatePrivateKey();
const polygonAccount = privateKeyToAccount(polygonPrivateKey);
const keyring = {
  version: 1 as const,
  keys: [
    composer.stored,
    backend.stored,
    {
      keyReference: references.polymarket,
      algorithm: "secp256k1" as const,
      privateKeyHex: polygonPrivateKey,
    },
    solanaSettlement.stored,
  ],
};

await writeFile(output, `${JSON.stringify(keyring, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});

process.stdout.write(`${JSON.stringify({
  message: "remote_signer_keyring_created",
  output,
  publicIdentities: [
    {
      role: "composer",
      ...composer.publicIdentity,
    },
    {
      role: "solana_completion",
      ...backend.publicIdentity,
    },
    {
      role: "polymarket_order",
      keyReference: references.polymarket,
      algorithm: "secp256k1",
      address: polygonAccount.address,
      publicKeyHex: `0x${Buffer.from(hexToBytes(polygonAccount.publicKey)).toString("hex")}`,
    },
    {
      role: "solana_settlement",
      ...solanaSettlement.publicIdentity,
    },
  ],
})}\n`);
