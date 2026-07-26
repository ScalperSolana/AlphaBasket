import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  verify as verifySignature,
} from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  bytesToHex,
  recoverAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { JsonHttpClient } from "../src/polymarket/index.js";
import {
  DevelopmentKeyProvider,
  createRemoteSignerHttpServer,
  loadRemoteSignerConfig,
  type RemoteSignerAuditEvent,
  type RemoteSignerAuditSink,
} from "../src/remote-signer/index.js";
import { HttpKeySigner } from "../src/signer/index.js";

const TOKEN = "remote-signer-test-token-that-is-at-least-32-characters";
const ED_KEY_REFERENCE = "alphabasket/composer/test";
const SECP_KEY_REFERENCE = "alphabasket/polymarket/test";
const SECP_PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;

function createTestKeyring() {
  const ed25519 = generateKeyPairSync("ed25519");
  const privateKey = ed25519.privateKey.export({ type: "pkcs8", format: "der" });
  if (!Buffer.isBuffer(privateKey)) throw new Error("test key export failed");
  return {
    ed25519,
    json: {
      version: 1,
      keys: [
        {
          keyReference: ED_KEY_REFERENCE,
          algorithm: "ed25519",
          privateKeyPkcs8Base64: privateKey.toString("base64"),
        },
        {
          keyReference: SECP_KEY_REFERENCE,
          algorithm: "secp256k1",
          privateKeyHex: SECP_PRIVATE_KEY,
        },
      ],
    },
  };
}

async function createKeyringFile(directory: string) {
  const keyring = createTestKeyring();
  const file = join(directory, "keyring.json");
  await writeFile(file, JSON.stringify(keyring.json), { mode: 0o600 });
  await chmod(file, 0o600);
  return { ...keyring, file };
}

class MemoryAuditSink implements RemoteSignerAuditSink {
  public readonly events: RemoteSignerAuditEvent[] = [];

  public record(event: RemoteSignerAuditEvent): void {
    this.events.push(event);
  }
}

describe("remote signer configuration", () => {
  it("loads the loopback development provider with bounded defaults", () => {
    const config = loadRemoteSignerConfig({
      NODE_ENV: "test",
      REMOTE_SIGNER_TOKEN: TOKEN,
      REMOTE_SIGNER_KEYRING_FILE: "/tmp/alphabasket-test-keyring.json",
    });
    assert.deepEqual(config, {
      environment: "test",
      host: "127.0.0.1",
      port: 3_003,
      bearerToken: TOKEN,
      provider: "development_file",
      keyringFile: "/tmp/alphabasket-test-keyring.json",
      maximumBodyBytes: 16_384,
      maximumConcurrentSignatures: 16,
    });
  });

  it("fails closed for production, non-loopback binding and relative keyrings", () => {
    const base = {
      NODE_ENV: "test",
      REMOTE_SIGNER_TOKEN: TOKEN,
      REMOTE_SIGNER_KEYRING_FILE: "/tmp/alphabasket-test-keyring.json",
    };
    assert.throws(
      () => loadRemoteSignerConfig({ ...base, NODE_ENV: "production" }),
      /forbidden in production/u,
    );
    assert.throws(
      () => loadRemoteSignerConfig({ ...base, REMOTE_SIGNER_HOST: "0.0.0.0" }),
      /only bind to loopback/u,
    );
    assert.throws(
      () => loadRemoteSignerConfig({
        ...base,
        REMOTE_SIGNER_KEYRING_FILE: "relative/keyring.json",
      }),
      /must be an absolute path/u,
    );
  });
});

describe("DevelopmentKeyProvider", () => {
  it("signs Ed25519 payloads and secp256k1 digests with the configured keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alphabasket-signer-"));
    try {
      const fixture = await createKeyringFile(directory);
      const provider = await DevelopmentKeyProvider.load(fixture.file);
      const message = Buffer.from("signed AlphaBasket composition", "utf8");
      const edSignature = await provider.sign({
        keyReference: ED_KEY_REFERENCE,
        algorithm: "ed25519",
        payload: message,
      });
      assert.equal(edSignature.publicKey.byteLength, 32);
      assert.equal(edSignature.signature.byteLength, 64);
      assert.equal(
        verifySignature(
          null,
          message,
          fixture.ed25519.publicKey,
          edSignature.signature,
        ),
        true,
      );

      const digest = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      const secpSignature = await provider.sign({
        keyReference: SECP_KEY_REFERENCE,
        algorithm: "secp256k1",
        payload: digest,
      });
      assert.equal(secpSignature.publicKey.byteLength, 65);
      assert.equal(secpSignature.signature.byteLength, 65);
      const recovered = await recoverAddress({
        hash: bytesToHex(digest),
        signature: bytesToHex(secpSignature.signature) as Hex,
      });
      assert.equal(
        recovered.toLowerCase(),
        privateKeyToAccount(SECP_PRIVATE_KEY).address.toLowerCase(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("denies unknown keys, algorithm substitution and non-digest EVM payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alphabasket-signer-"));
    try {
      const fixture = await createKeyringFile(directory);
      const provider = await DevelopmentKeyProvider.load(fixture.file);
      await assert.rejects(provider.sign({
        keyReference: "unknown/key",
        algorithm: "ed25519",
        payload: new Uint8Array([1]),
      }), /denied/u);
      await assert.rejects(provider.sign({
        keyReference: ED_KEY_REFERENCE,
        algorithm: "secp256k1",
        payload: new Uint8Array(32),
      }), /denied/u);
      await assert.rejects(provider.sign({
        keyReference: SECP_KEY_REFERENCE,
        algorithm: "secp256k1",
        payload: new Uint8Array(31),
      }), /32-byte digest/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses group-readable keyrings and symbolic links", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alphabasket-signer-"));
    try {
      const fixture = await createKeyringFile(directory);
      await chmod(fixture.file, 0o640);
      if (process.platform !== "win32") {
        await assert.rejects(
          DevelopmentKeyProvider.load(fixture.file),
          /permissions must be owner-only/u,
        );
      }
      await chmod(fixture.file, 0o600);
      const link = join(directory, "keyring-link.json");
      await symlink(fixture.file, link);
      await assert.rejects(
        DevelopmentKeyProvider.load(link),
        /must not be a symbolic link/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("remote signer HTTP boundary", () => {
  it("is wire-compatible with HttpKeySigner and audits only the payload hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alphabasket-signer-"));
    const audit = new MemoryAuditSink();
    const fixture = await createKeyringFile(directory);
    const provider = await DevelopmentKeyProvider.load(fixture.file);
    const server = createRemoteSignerHttpServer({
      provider,
      bearerToken: TOKEN,
      auditSink: audit,
      requestId: () => "signer-request-1",
      now: () => new Date("2026-07-26T12:00:00.000Z"),
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test signer did not bind to TCP");
      }
      const client = new HttpKeySigner(
        new JsonHttpClient({ fetch: globalThis.fetch, timeoutMs: 2_000 }),
        TOKEN,
        {
          baseUrl: `http://127.0.0.1:${address.port}`,
          allowInsecureLocalhost: true,
        },
      );
      const message = Buffer.from("wire-compatible request", "utf8");
      const signed = await client.sign({
        keyReference: ED_KEY_REFERENCE,
        algorithm: "ed25519",
        payload: message,
      });
      assert.equal(
        verifySignature(null, message, fixture.ed25519.publicKey, signed.signature),
        true,
      );
      assert.deepEqual(audit.events.map((event) => ({
        requestId: event.requestId,
        keyReference: event.keyReference,
        algorithm: event.algorithm,
        outcome: event.outcome,
        hasPayloadHash: event.payloadHash?.length === 64,
      })), [{
        requestId: "signer-request-1",
        keyReference: ED_KEY_REFERENCE,
        algorithm: "ed25519",
        outcome: "signed",
        hasPayloadHash: true,
      }]);
      assert.equal(JSON.stringify(audit.events).includes(message.toString("utf8")), false);
    } finally {
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects missing authentication, wrong versions and key/algorithm misuse", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alphabasket-signer-"));
    const fixture = await createKeyringFile(directory);
    const provider = await DevelopmentKeyProvider.load(fixture.file);
    const audit = new MemoryAuditSink();
    const server = createRemoteSignerHttpServer({
      provider,
      bearerToken: TOKEN,
      auditSink: audit,
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("test signer did not bind to TCP");
      }
      const url = `http://127.0.0.1:${address.port}/v1/sign`;
      const body = JSON.stringify({
        keyReference: ED_KEY_REFERENCE,
        algorithm: "ed25519",
        payloadBase64: Buffer.from("request").toString("base64"),
      });
      const unauthorized = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alphabasket-request-version": "1",
        },
        body,
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.headers.get("cache-control"), "no-store");

      const wrongVersion = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-alphabasket-request-version": "2",
        },
        body,
      });
      assert.equal(wrongVersion.status, 400);

      const wrongAlgorithm = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "x-alphabasket-request-version": "1",
        },
        body: JSON.stringify({
          keyReference: ED_KEY_REFERENCE,
          algorithm: "secp256k1",
          payloadBase64: Buffer.alloc(32, 1).toString("base64"),
        }),
      });
      assert.equal(wrongAlgorithm.status, 403);
      assert.deepEqual(await wrongAlgorithm.json(), { error: "signing_denied" });
      assert.equal(
        audit.events.some((event) =>
          event.outcome === "denied" && event.reason === "policy_denied"
        ),
        true,
      );
    } finally {
      server.close();
      await once(server, "close");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
