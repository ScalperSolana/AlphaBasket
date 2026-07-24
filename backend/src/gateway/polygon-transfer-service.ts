import { createHash } from "node:crypto";

import {
  bytesToHex,
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  keccak256,
  parseSignature,
  recoverAddress,
  serializeTransaction,
  type Address,
  type Hex,
} from "viem";

import type { PolicyEnforcedSigner } from "../signer/index.js";
import type {
  GatewayPusdTransferRequest,
  GatewayRequestStorePort,
} from "./types.js";

export interface PolygonTransferRpcPort {
  getTransactionCount(address: Address): Promise<number>;
  estimateFeesPerGas(): Promise<{
    readonly maxFeePerGas: bigint;
    readonly maxPriorityFeePerGas: bigint;
  }>;
  estimateGas(request: {
    readonly account: Address;
    readonly to: Address;
    readonly data: Hex;
  }): Promise<bigint>;
  getFinalizedReceipt(hash: Hex): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
  } | null>;
  sendRawTransaction(serializedTransaction: Hex): Promise<Hex>;
  waitForFinalizedReceipt(hash: Hex): Promise<{
    readonly status: "success" | "reverted";
    readonly blockNumber: bigint;
  }>;
}

function canonicalHash(request: GatewayPusdTransferRequest): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_REMOTE_PUSD_TRANSFER_V1",
    request.deploymentMode,
    request.idempotencyKey,
    request.destinationEvmAddress.toLowerCase(),
    request.amountUnits.toString(10),
  ]), "utf8").digest("hex");
}

function signatureHex(value: Uint8Array): Hex {
  if (value.byteLength !== 65) throw new Error("Polygon signer must return a 65-byte recoverable signature");
  return bytesToHex(value);
}

export interface PolygonPusdTransferOptions {
  readonly deploymentMode: GatewayPusdTransferRequest["deploymentMode"];
  readonly executionWallet: Address;
  readonly pusdToken: Address;
  readonly maximumTransferUnits: bigint;
  readonly maximumNetworkFeeWei: bigint;
  readonly now?: () => Date;
}

export class PolygonPusdTransferGateway {
  private readonly now: () => Date;

  public constructor(
    private readonly store: GatewayRequestStorePort,
    private readonly signer: PolicyEnforcedSigner,
    private readonly rpc: PolygonTransferRpcPort,
    private readonly options: PolygonPusdTransferOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    if (options.maximumTransferUnits <= 0n || options.maximumNetworkFeeWei <= 0n) {
      throw new RangeError("Polygon transfer limits must be positive");
    }
  }

  public async transferPusd(request: GatewayPusdTransferRequest): Promise<{
    readonly requestHash: string;
    readonly transactionHash: string;
  }> {
    this.validate(request);
    const hash = canonicalHash(request);
    if (hash !== request.requestHash) {
      throw new Error("pUSD gateway request hash does not match its canonical content");
    }
    const requestKey = `pusd:${request.idempotencyKey}`;
    const prepared = await this.store.prepare({
      requestKey,
      requestKind: "pusd_transfer",
      requestHash: hash,
      build: async () => this.buildSignedTransfer(request, hash),
      now: this.now(),
    });
    const transactionHash = prepared.transactionReference;
    if (transactionHash === null || !/^0x[0-9a-f]{64}$/u.test(transactionHash)) {
      throw new Error("journaled Polygon transfer is missing its transaction hash");
    }
    if (prepared.state === "finalized") {
      return Object.freeze({ requestHash: hash, transactionHash });
    }
    const txHash = transactionHash as Hex;
    let receipt = await this.rpc.getFinalizedReceipt(txHash);
    if (receipt === null) {
      const serialized = bytesToHex(prepared.signedPayload);
      try {
        const submitted = await this.rpc.sendRawTransaction(serialized);
        if (submitted.toLowerCase() !== txHash.toLowerCase()) {
          throw new Error("Polygon RPC returned a hash different from the journaled transaction");
        }
      } catch (error) {
        receipt = await this.rpc.getFinalizedReceipt(txHash);
        if (receipt === null) throw error;
      }
      await this.store.markSubmitted(requestKey, transactionHash, this.now());
      receipt ??= await this.rpc.waitForFinalizedReceipt(txHash);
    }
    if (receipt.status !== "success") throw new Error("Polygon pUSD transfer reverted");
    await this.store.markFinalized(requestKey, transactionHash, {
      transactionHash,
      finalizedBlock: receipt.blockNumber.toString(10),
    }, this.now());
    return Object.freeze({ requestHash: hash, transactionHash });
  }

  private validate(request: GatewayPusdTransferRequest): void {
    if (request.deploymentMode !== this.options.deploymentMode) {
      throw new Error("pUSD transfer deployment mode does not match the gateway");
    }
    if (!/^[A-Za-z0-9_.:-]{8,128}$/u.test(request.idempotencyKey)) {
      throw new TypeError("pUSD transfer idempotency key is invalid");
    }
    if (!/^0x[0-9a-fA-F]{40}$/u.test(request.destinationEvmAddress)) {
      throw new TypeError("pUSD transfer destination is invalid");
    }
    if (
      request.destinationEvmAddress.toLowerCase() === this.options.executionWallet.toLowerCase() ||
      request.amountUnits <= 0n ||
      request.amountUnits > this.options.maximumTransferUnits
    ) {
      throw new RangeError("pUSD transfer violates the gateway amount or destination policy");
    }
  }

  private async buildSignedTransfer(
    request: GatewayPusdTransferRequest,
    requestHash: string,
  ): Promise<{ readonly signedPayload: Uint8Array; readonly transactionReference: string }> {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [request.destinationEvmAddress as Address, request.amountUnits],
    });
    const [nonce, fees, estimatedGas] = await Promise.all([
      this.rpc.getTransactionCount(this.options.executionWallet),
      this.rpc.estimateFeesPerGas(),
      this.rpc.estimateGas({
        account: this.options.executionWallet,
        to: this.options.pusdToken,
        data,
      }),
    ]);
    const gas = (estimatedGas * 120n + 99n) / 100n;
    if (
      fees.maxFeePerGas <= 0n ||
      fees.maxPriorityFeePerGas <= 0n ||
      fees.maxPriorityFeePerGas > fees.maxFeePerGas ||
      gas * fees.maxFeePerGas > this.options.maximumNetworkFeeWei
    ) {
      throw new Error("Polygon fee quote violates the gateway fee policy");
    }
    const transaction = {
      chainId: 137,
      type: "eip1559" as const,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      to: this.options.pusdToken,
      value: 0n,
      data,
    };
    const unsigned = serializeTransaction(transaction);
    const digest = keccak256(unsigned);
    const signed = await this.signer.sign({
      role: "polymarket_order",
      payload: hexToBytes(digest),
      context: {
        domain: "alphabasket:polygon-transaction:v1",
        action: "transfer_pusd",
        network: "polygon-mainnet",
        expiresAt: new Date(this.now().getTime() + 60_000),
        intentHash: requestHash,
      },
    });
    const signature = signatureHex(signed.signature);
    const recovered = await recoverAddress({ hash: digest, signature });
    if (recovered.toLowerCase() !== this.options.executionWallet.toLowerCase()) {
      throw new Error("Polygon transaction signature does not recover to the execution wallet");
    }
    const serialized = serializeTransaction(transaction, parseSignature(signature));
    return Object.freeze({
      signedPayload: hexToBytes(serialized),
      transactionReference: keccak256(serialized),
    });
  }
}
