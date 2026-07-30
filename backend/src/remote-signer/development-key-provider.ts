import {
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  type KeyObject,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { hexToBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";

import type {
  KeySignature,
  KeySigningRequest,
} from "../signer/types.js";
import {
  REMOTE_SIGNER_MAXIMUM_PAYLOAD_BYTES,
  RemoteSignerAccessError,
  type RemoteSignerKeyIdentity,
  type RemoteSignerKeyProvider,
} from "./types.js";

const MAXIMUM_KEYRING_BYTES = 65_536;
const ED25519_PUBLIC_KEY_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const canonicalBase64 = z.string().min(4).max(8_192).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
);
const keyReference = z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:/-]+$/u);

const ed25519KeySchema = z.object({
  keyReference,
  algorithm: z.literal("ed25519"),
  privateKeyPkcs8Base64: canonicalBase64,
}).strict();
const secp256k1KeySchema = z.object({
  keyReference,
  algorithm: z.literal("secp256k1"),
  privateKeyHex: z.string().regex(/^0x[0-9a-fA-F]{64}$/u),
}).strict();
const keyringSchema = z.object({
  version: z.literal(1),
  keys: z.array(z.discriminatedUnion("algorithm", [
    ed25519KeySchema,
    secp256k1KeySchema,
  ])).min(1).max(64),
}).strict();

interface Ed25519Key {
  readonly algorithm: "ed25519";
  readonly privateKey: KeyObject;
  readonly publicKey: Uint8Array;
}

interface Secp256k1Key {
  readonly algorithm: "secp256k1";
  readonly account: PrivateKeyAccount;
  readonly publicKey: Uint8Array;
}

type LoadedKey = Ed25519Key | Secp256k1Key;

function decodeCanonicalBase64(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${name} must use canonical base64`);
  }
  return decoded;
}

function rawEd25519PublicKey(privateKey: KeyObject): Uint8Array {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (
    !Buffer.isBuffer(der) ||
    der.byteLength !== ED25519_PUBLIC_KEY_DER_PREFIX.byteLength + 32 ||
    !der.subarray(0, ED25519_PUBLIC_KEY_DER_PREFIX.byteLength)
      .equals(ED25519_PUBLIC_KEY_DER_PREFIX)
  ) {
    throw new Error("keyring contains an invalid Ed25519 key");
  }
  return Uint8Array.from(der.subarray(ED25519_PUBLIC_KEY_DER_PREFIX.byteLength));
}

function assertSigningRequest(request: KeySigningRequest): void {
  if (request.keyReference.length === 0 || request.keyReference.length > 512) {
    throw new RemoteSignerAccessError();
  }
  if (
    request.payload.byteLength === 0 ||
    request.payload.byteLength > REMOTE_SIGNER_MAXIMUM_PAYLOAD_BYTES
  ) {
    throw new RemoteSignerAccessError();
  }
}

/**
 * Internal-testing provider. Private keys remain in an owner-readable file and
 * are never exposed through this class. Production deployments must replace
 * this provider with a KMS/HSM implementation of RemoteSignerKeyProvider.
 */
export class DevelopmentKeyProvider implements RemoteSignerKeyProvider {
  private constructor(private readonly keys: ReadonlyMap<string, LoadedKey>) {}

  public static async load(filePath: string): Promise<DevelopmentKeyProvider> {
    if (!isAbsolute(filePath)) {
      throw new Error("REMOTE_SIGNER_KEYRING_FILE must be an absolute path");
    }
    const linkInfo = await lstat(filePath);
    if (linkInfo.isSymbolicLink()) {
      throw new Error("remote signer keyring must not be a symbolic link");
    }
    const handle = await open(
      filePath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let json: unknown;
    try {
      const fileInfo = await handle.stat();
      if (!fileInfo.isFile()) {
        throw new Error("remote signer keyring must be a regular file");
      }
      if (fileInfo.size === 0 || fileInfo.size > MAXIMUM_KEYRING_BYTES) {
        throw new Error("remote signer keyring size is invalid");
      }
      if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
        throw new Error(
          "remote signer keyring permissions must be owner-only (chmod 600)",
        );
      }
      const raw = await handle.readFile();
      try {
        json = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        throw new Error("remote signer keyring is not valid JSON");
      } finally {
        raw.fill(0);
      }
    } finally {
      await handle.close();
    }
    const parsed = keyringSchema.safeParse(json);
    if (!parsed.success) throw new Error("remote signer keyring schema is invalid");

    const keys = new Map<string, LoadedKey>();
    for (const entry of parsed.data.keys) {
      if (keys.has(entry.keyReference)) {
        throw new Error("remote signer keyring contains a duplicate key reference");
      }
      if (entry.algorithm === "ed25519") {
        const privateKey = createPrivateKey({
          key: decodeCanonicalBase64(
            entry.privateKeyPkcs8Base64,
            "Ed25519 private key",
          ),
          type: "pkcs8",
          format: "der",
        });
        if (privateKey.asymmetricKeyType !== "ed25519") {
          throw new Error("keyring Ed25519 entry contains the wrong key type");
        }
        keys.set(entry.keyReference, Object.freeze({
          algorithm: "ed25519",
          privateKey,
          publicKey: rawEd25519PublicKey(privateKey),
        }));
      } else {
        const account = privateKeyToAccount(entry.privateKeyHex as Hex);
        keys.set(entry.keyReference, Object.freeze({
          algorithm: "secp256k1",
          account,
          publicKey: Uint8Array.from(hexToBytes(account.publicKey)),
        }));
      }
    }
    return new DevelopmentKeyProvider(keys);
  }

  public identities(): readonly RemoteSignerKeyIdentity[] {
    return Object.freeze([...this.keys.entries()].map(([keyReference, key]) =>
      Object.freeze({
        keyReference,
        algorithm: key.algorithm,
        publicKey: Uint8Array.from(key.publicKey),
      })
    ));
  }

  public async sign(request: KeySigningRequest): Promise<KeySignature> {
    assertSigningRequest(request);
    const key = this.keys.get(request.keyReference);
    if (key === undefined || key.algorithm !== request.algorithm) {
      throw new RemoteSignerAccessError();
    }
    if (key.algorithm === "ed25519") {
      const signature = signEd25519(null, request.payload, key.privateKey);
      return Object.freeze({
        signature: Uint8Array.from(signature),
        publicKey: Uint8Array.from(key.publicKey),
      });
    }
    if (request.payload.byteLength !== 32) {
      throw new RemoteSignerAccessError(
        "secp256k1 signing requires an exact 32-byte digest",
      );
    }
    const signature = await key.account.sign({
      hash: `0x${Buffer.from(request.payload).toString("hex")}`,
    });
    return Object.freeze({
      signature: Uint8Array.from(hexToBytes(signature)),
      publicKey: Uint8Array.from(key.publicKey),
    });
  }
}
