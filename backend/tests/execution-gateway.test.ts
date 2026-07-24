import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { describe, it } from "node:test";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  bytesToHex,
  getAddress,
  hexToBytes,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  ClobOrderGateway,
  createExecutionGatewayHttpServer,
  solanaCapitalSplitMessageValidator,
  type GatewayRequestKind,
  type GatewayRequestStorePort,
  type PreparedGatewayRequest,
} from "../src/gateway/index.js";
import {
  InMemorySignerAuditSink,
  PolicyEnforcedSigner,
  type KeySignerPort,
} from "../src/signer/index.js";

const NOW = new Date("2026-07-24T10:00:00.000Z");
const PRIVATE_KEY =
  "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as const;
const CLOB_SECRET = Buffer.from("alphabasket-clob-test-secret-32").toString("base64url");
const API_KEY = "11111111-2222-4333-8444-555555555555";
const API_PASSPHRASE = "test-passphrase-not-production";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID =
  new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

class MemoryGatewayStore implements GatewayRequestStorePort {
  public readonly entries = new Map<string, PreparedGatewayRequest>();

  public async prepare(request: {
    readonly requestKey: string;
    readonly requestKind: GatewayRequestKind;
    readonly requestHash: string;
    readonly build: () => Promise<{
      readonly signedPayload: Uint8Array;
      readonly transactionReference?: string;
    }>;
    readonly now: Date;
  }): Promise<PreparedGatewayRequest> {
    const existing = this.entries.get(request.requestKey);
    if (existing !== undefined) {
      if (
        existing.requestKind !== request.requestKind ||
        existing.requestHash !== request.requestHash
      ) {
        throw new Error("execution gateway request key was reused with different content");
      }
      return existing;
    }
    const built = await request.build();
    const created = Object.freeze({
      requestKey: request.requestKey,
      requestKind: request.requestKind,
      requestHash: request.requestHash,
      signedPayload: Uint8Array.from(built.signedPayload),
      transactionReference: built.transactionReference ?? null,
      state: "prepared" as const,
      result: null,
    });
    this.entries.set(request.requestKey, created);
    return created;
  }

  public async markSubmitted(
    requestKey: string,
    transactionReference: string,
    _now: Date,
  ): Promise<void> {
    const existing = this.required(requestKey);
    if (
      existing.transactionReference !== null &&
      existing.transactionReference !== transactionReference
    ) {
      throw new Error("execution gateway submission journal conflict");
    }
    this.entries.set(requestKey, Object.freeze({
      ...existing,
      state: existing.state === "finalized" ? "finalized" : "submitted",
      transactionReference,
    }));
  }

  public async markFinalized(
    requestKey: string,
    transactionReference: string,
    result: Readonly<Record<string, unknown>>,
    _now: Date,
  ): Promise<void> {
    const existing = this.required(requestKey);
    if (
      existing.transactionReference !== null &&
      existing.transactionReference !== transactionReference
    ) {
      throw new Error("execution gateway finalization journal conflict");
    }
    this.entries.set(requestKey, Object.freeze({
      ...existing,
      state: "finalized",
      transactionReference,
      result: Object.freeze({ ...result }),
    }));
  }

  private required(requestKey: string): PreparedGatewayRequest {
    const existing = this.entries.get(requestKey);
    if (existing === undefined) throw new Error("missing gateway request");
    return existing;
  }
}

function clobSigner() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const keySigner: KeySignerPort = {
    sign: async (request) => ({
      signature: hexToBytes(await account.sign({
        hash: bytesToHex(request.payload),
      })),
      publicKey: hexToBytes(account.publicKey),
    }),
  };
  const audit = new InMemorySignerAuditSink();
  return {
    account,
    audit,
    signer: new PolicyEnforcedSigner({
      policies: [{
        role: "polymarket_order",
        keyReference: "kms://polymarket-test",
        algorithm: "secp256k1",
        expectedPublicKey: hexToBytes(account.publicKey),
        allowedDomains: new Set(["alphabasket:polymarket-order:v2"]),
        allowedActions: new Set(["sign_fak_order"]),
        allowedNetworks: new Set(["polygon-mainnet"]),
        maxPayloadBytes: 32,
        requireExpiry: true,
        maxExpiryMs: 60_000,
        requiredContext: new Set(["intentHash"]),
        validatePayload: (payload) => {
          if (payload.byteLength !== 32) throw new Error("digest must be 32 bytes");
        },
      }],
      keySigner,
      auditSink: audit,
      now: () => NOW,
    }),
  };
}

describe("key-holding execution gateway", () => {
  it("journals an exact official CLOB v2 FAK body and authenticates that body", async () => {
    const store = new MemoryGatewayStore();
    const { account, audit, signer } = clobSigner();
    const gateway = new ClobOrderGateway(store, signer, {
      deploymentMode: "hybrid_devnet",
      walletAddress: getAddress(account.address),
      apiKey: API_KEY,
      apiSecret: CLOB_SECRET,
      apiPassphrase: API_PASSPHRASE,
      maximumMakerUnits: 10_000_000n,
      maximumTakerUnits: 100_000_000n,
      now: () => NOW,
    });
    const clientOrderId = "11111111-2222-4333-8444-555555555555:buy:0";
    const requestHash = sha256([
      "ALPHABASKET_REMOTE_FAK_ORDER_V1",
      "hybrid_devnet",
      clientOrderId,
      "123456789",
      "BUY",
      "1",
      "5000000",
      "6250000",
    ]);
    const request = {
      requestHash,
      deploymentMode: "hybrid_devnet" as const,
      clientOrderId,
      tokenId: "123456789",
      side: "BUY" as const,
      negativeRisk: true,
      makerAmountUnits: 5_000_000n,
      takerAmountUnits: 6_250_000n,
    };
    const first = await gateway.signFakOrder(request);
    const second = await gateway.signFakOrder(request);
    const body = Buffer.from(first.serializedBodyBase64, "base64").toString("utf8");
    const parsed = JSON.parse(body) as {
      readonly order: {
        readonly maker: string;
        readonly signer: string;
        readonly timestamp: string;
        readonly signature: string;
      };
      readonly owner: string;
      readonly orderType: string;
      readonly postOnly: boolean;
      readonly deferExec: boolean;
    };

    assert.equal(first.serializedBodyBase64, second.serializedBodyBase64);
    assert.equal(store.entries.size, 1);
    assert.equal(audit.events.length, 1);
    assert.equal(parsed.order.maker, account.address);
    assert.equal(parsed.order.signer, account.address);
    assert.equal(parsed.order.timestamp, NOW.getTime().toString(10));
    assert.match(parsed.order.signature, /^0x[0-9a-f]{130}$/u);
    assert.equal(parsed.owner, API_KEY);
    assert.equal(parsed.orderType, "FAK");
    assert.equal(parsed.postOnly, false);
    assert.equal(parsed.deferExec, false);

    const timestamp = first.authenticationHeaders.POLY_TIMESTAMP;
    assert.equal(typeof timestamp, "string");
    const expectedHmac = createHmac(
      "sha256",
      Buffer.from(CLOB_SECRET.replace(/-/gu, "+").replace(/_/gu, "/"), "base64"),
    )
      .update(`${timestamp}POST/order${body}`, "utf8")
      .digest("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
    assert.equal(first.authenticationHeaders.POLY_SIGNATURE, expectedHmac);
    assert.equal(first.authenticationHeaders.POLY_ADDRESS, account.address);
  });

  it("rejects content tampering and amount-limit bypasses before signing", async () => {
    const store = new MemoryGatewayStore();
    const { account, audit, signer } = clobSigner();
    const gateway = new ClobOrderGateway(store, signer, {
      deploymentMode: "hybrid_devnet",
      walletAddress: account.address,
      apiKey: API_KEY,
      apiSecret: CLOB_SECRET,
      apiPassphrase: API_PASSPHRASE,
      maximumMakerUnits: 1_000n,
      maximumTakerUnits: 1_000n,
      now: () => NOW,
    });
    const base = {
      requestHash: "0".repeat(64),
      deploymentMode: "hybrid_devnet" as const,
      clientOrderId: "11111111-2222-4333-8444-555555555555:sell:0",
      tokenId: "7",
      side: "SELL" as const,
      negativeRisk: false,
      makerAmountUnits: 1n,
      takerAmountUnits: 1n,
    };
    await assert.rejects(gateway.signFakOrder(base), /request hash/u);
    await assert.rejects(
      gateway.signFakOrder({ ...base, makerAmountUnits: 1_001n }),
      /amount policy/u,
    );
    assert.equal(audit.events.length, 0);
    assert.equal(store.entries.size, 0);
  });

  it("accepts only the canonical mainnet USDC split message shape", () => {
    const source = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const sourceAta = PublicKey.findProgramAddressSync(
      [source.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
    const destinationAta = PublicKey.findProgramAddressSync(
      [recipient.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )[0];
    const createAta = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: source, isSigner: true, isWritable: true },
        { pubkey: destinationAta, isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
    const transferData = Buffer.alloc(10);
    transferData.writeUInt8(12, 0);
    transferData.writeBigUInt64LE(500n, 1);
    transferData.writeUInt8(6, 9);
    const transfer = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: sourceAta, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: destinationAta, isSigner: false, isWritable: true },
        { pubkey: source, isSigner: true, isWritable: false },
      ],
      data: transferData,
    });
    const valid = new Transaction({
      feePayer: source,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(createAta, transfer);
    const validate = solanaCapitalSplitMessageValidator({
      sourceOwner: source,
      usdcMint: mint,
      maximumSplitUnits: 1_000n,
    });
    assert.doesNotThrow(() => validate(valid.serializeMessage()));

    const malicious = new Transaction({
      feePayer: source,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
    }).add(SystemProgram.transfer({
      fromPubkey: source,
      toPubkey: recipient,
      lamports: 1,
    }));
    assert.throws(
      () => validate(malicious.serializeMessage()),
      /unapproved program/u,
    );
  });

  it("requires authenticated, versioned, strictly validated gateway requests", async () => {
    const token = "gateway-test-token-at-least-thirty-two-characters";
    let invoked = 0;
    const server = createExecutionGatewayHttpServer({
      bearerToken: token,
      service: {
        signFakOrder: async (request) => {
          invoked += 1;
          return {
            requestHash: request.requestHash,
            serializedBodyBase64: Buffer.from("{}", "utf8").toString("base64"),
            authenticationHeaders: {},
          };
        },
        transferPusd: async () => ({
          requestHash: "0".repeat(64),
          transactionHash: `0x${"0".repeat(64)}`,
        }),
        splitSolanaUsdc: async () => ({
          requestHash: "0".repeat(64),
          transactionSignature: bs58.encode(new Uint8Array(64)),
          finalizedSlot: 1n,
        }),
      },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server did not bind TCP");
    const url = `http://127.0.0.1:${address.port}/v1/polymarket/fak-order`;
    const payload = {
      requestHash: "0".repeat(64),
      deploymentMode: "hybrid_devnet",
      clientOrderId: "11111111-2222-4333-8444-555555555555:buy:0",
      tokenId: "1",
      side: "BUY",
      negativeRisk: false,
      makerAmountUnits: "1",
      takerAmountUnits: "1",
    };
    try {
      const unauthorized = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-alphabasket-request-version": "1",
        },
        body: JSON.stringify(payload),
      });
      assert.equal(unauthorized.status, 401);
      assert.equal(invoked, 0);

      const invalid = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-alphabasket-request-version": "1",
        },
        body: JSON.stringify({ ...payload, unexpected: true }),
      });
      assert.equal(invalid.status, 400);
      assert.equal(invoked, 0);

      const accepted = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-alphabasket-request-version": "1",
        },
        body: JSON.stringify(payload),
      });
      assert.equal(accepted.status, 200);
      assert.equal(invoked, 1);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
