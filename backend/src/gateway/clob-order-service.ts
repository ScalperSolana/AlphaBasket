import { createHash, createHmac } from "node:crypto";

import {
  bytesToHex,
  hashTypedData,
  hexToBytes,
  recoverAddress,
  type Address,
  type Hex,
} from "viem";

import type { PolicyEnforcedSigner } from "../signer/index.js";
import type {
  GatewayFakOrderRequest,
  GatewayFakOrderResult,
  GatewayRequestStorePort,
} from "./types.js";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const CTF_EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

function requestHash(request: GatewayFakOrderRequest): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_REMOTE_FAK_ORDER_V1",
    request.deploymentMode,
    request.clientOrderId,
    request.tokenId,
    request.side,
    request.negativeRisk ? "1" : "0",
    request.makerAmountUnits.toString(10),
    request.takerAmountUnits.toString(10),
  ]), "utf8").digest("hex");
}

function deterministicSalt(clientOrderId: string): number {
  const bytes = createHash("sha256").update(
    `ALPHABASKET_CLOB_SALT_V1:${clientOrderId}`,
    "utf8",
  ).digest();
  return bytes.readUIntBE(0, 6);
}

function hmacSecret(value: string): Buffer {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = `${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`;
  const decoded = Buffer.from(padded, "base64");
  if (decoded.byteLength < 16 || decoded.toString("base64").replace(/=+$/u, "") !== padded.replace(/=+$/u, "")) {
    throw new TypeError("Polymarket CLOB API secret is not canonical base64url");
  }
  return decoded;
}

function signatureHex(value: Uint8Array): Hex {
  const hex = bytesToHex(value);
  if (value.byteLength !== 65) throw new Error("Polymarket signer must return a 65-byte recoverable signature");
  return hex;
}

export interface ClobOrderGatewayOptions {
  readonly deploymentMode: GatewayFakOrderRequest["deploymentMode"];
  readonly walletAddress: Address;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apiPassphrase: string;
  readonly builderCode?: Hex;
  readonly maximumMakerUnits: bigint;
  readonly maximumTakerUnits: bigint;
  readonly now?: () => Date;
}

/**
 * Constructs Polymarket CLOB v2 EOA orders using integer amounts only. The
 * exact signed body is journaled before it leaves the key boundary; L2 HMAC
 * headers can be refreshed safely while every replay keeps the same order hash.
 */
export class ClobOrderGateway {
  private readonly secret: Buffer;
  private readonly now: () => Date;

  public constructor(
    private readonly store: GatewayRequestStorePort,
    private readonly signer: PolicyEnforcedSigner,
    private readonly options: ClobOrderGatewayOptions,
  ) {
    this.secret = hmacSecret(options.apiSecret);
    this.now = options.now ?? (() => new Date());
    if (options.apiKey.length < 8 || options.apiKey.length > 256) {
      throw new RangeError("Polymarket CLOB API key has an invalid length");
    }
    if (options.apiPassphrase.length < 8 || options.apiPassphrase.length > 512) {
      throw new RangeError("Polymarket CLOB API passphrase has an invalid length");
    }
    if (options.maximumMakerUnits <= 0n || options.maximumTakerUnits <= 0n) {
      throw new RangeError("Polymarket order limits must be positive");
    }
  }

  public async signFakOrder(request: GatewayFakOrderRequest): Promise<GatewayFakOrderResult> {
    this.validate(request);
    const computedHash = requestHash(request);
    if (computedHash !== request.requestHash) {
      throw new Error("FAK gateway request hash does not match its canonical content");
    }
    const prepared = await this.store.prepare({
      requestKey: `fak:${request.clientOrderId}`,
      requestKind: "fak_order",
      requestHash: computedHash,
      build: async () => {
        const serializedBody = await this.buildSignedBody(request);
        return { signedPayload: Buffer.from(serializedBody, "utf8") };
      },
      now: this.now(),
    });
    const serializedBody = Buffer.from(prepared.signedPayload).toString("utf8");
    const parsed = JSON.parse(serializedBody) as {
      readonly order?: { readonly maker?: unknown; readonly tokenId?: unknown };
      readonly owner?: unknown;
      readonly orderType?: unknown;
    };
    if (
      parsed.order?.maker !== this.options.walletAddress ||
      parsed.order.tokenId !== request.tokenId ||
      parsed.owner !== this.options.apiKey ||
      parsed.orderType !== "FAK"
    ) {
      throw new Error("journaled FAK body does not match the configured execution identity");
    }
    const timestamp = Math.floor(this.now().getTime() / 1_000).toString(10);
    const message = `${timestamp}POST/order${serializedBody}`;
    const signature = createHmac("sha256", this.secret)
      .update(message, "utf8")
      .digest("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_");
    return Object.freeze({
      requestHash: computedHash,
      serializedBodyBase64: Buffer.from(serializedBody, "utf8").toString("base64"),
      authenticationHeaders: Object.freeze({
        POLY_ADDRESS: this.options.walletAddress,
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: timestamp,
        POLY_API_KEY: this.options.apiKey,
        POLY_PASSPHRASE: this.options.apiPassphrase,
      }),
    });
  }

  private validate(request: GatewayFakOrderRequest): void {
    if (request.deploymentMode !== this.options.deploymentMode) {
      throw new Error("FAK request deployment mode does not match the gateway");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(?:buy|sell):[0-9]+$/iu
        .test(request.clientOrderId)
    ) {
      throw new TypeError("FAK client order ID is not canonical");
    }
    if (!/^(?:0|[1-9][0-9]*)$/u.test(request.tokenId)) {
      throw new TypeError("FAK token ID must be a canonical unsigned integer");
    }
    if (
      request.makerAmountUnits <= 0n ||
      request.makerAmountUnits > this.options.maximumMakerUnits ||
      request.takerAmountUnits <= 0n ||
      request.takerAmountUnits > this.options.maximumTakerUnits
    ) {
      throw new RangeError("FAK order exceeds the gateway amount policy");
    }
  }

  private async buildSignedBody(request: GatewayFakOrderRequest): Promise<string> {
    const timestamp = BigInt(this.now().getTime());
    const salt = deterministicSalt(request.clientOrderId);
    const exchange = (request.negativeRisk ? NEG_RISK_EXCHANGE_V2 : CTF_EXCHANGE_V2) as Address;
    const message = {
      salt: BigInt(salt),
      maker: this.options.walletAddress,
      signer: this.options.walletAddress,
      tokenId: BigInt(request.tokenId),
      makerAmount: request.makerAmountUnits,
      takerAmount: request.takerAmountUnits,
      side: request.side === "BUY" ? 0 : 1,
      signatureType: 0,
      timestamp,
      metadata: ZERO_BYTES32,
      builder: this.options.builderCode ?? ZERO_BYTES32,
    } as const;
    const digest = hashTypedData({
      domain: {
        name: "Polymarket CTF Exchange",
        version: "2",
        chainId: 137,
        verifyingContract: exchange,
      },
      types: ORDER_TYPES,
      primaryType: "Order",
      message,
    });
    const signed = await this.signer.sign({
      role: "polymarket_order",
      payload: hexToBytes(digest),
      context: {
        domain: "alphabasket:polymarket-order:v2",
        action: "sign_fak_order",
        network: "polygon-mainnet",
        expiresAt: new Date(this.now().getTime() + 60_000),
        intentHash: request.requestHash,
      },
    });
    const signature = signatureHex(signed.signature);
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() !== this.options.walletAddress.toLowerCase()) {
      throw new Error("Polymarket order signature does not recover to the execution wallet");
    }
    return JSON.stringify({
      deferExec: false,
      postOnly: false,
      order: {
        salt,
        maker: this.options.walletAddress,
        signer: this.options.walletAddress,
        tokenId: request.tokenId,
        makerAmount: request.makerAmountUnits.toString(10),
        takerAmount: request.takerAmountUnits.toString(10),
        side: request.side,
        signatureType: 0,
        timestamp: timestamp.toString(10),
        expiration: "0",
        metadata: ZERO_BYTES32,
        builder: this.options.builderCode ?? ZERO_BYTES32,
        signature,
      },
      owner: this.options.apiKey,
      orderType: "FAK",
    });
  }
}
