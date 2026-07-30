import { createHash } from "node:crypto";

import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import bs58 from "bs58";

import { Web3SolanaBridgeReceiptVerifier } from "../runtime/index.js";
import type { PolicyEnforcedSigner } from "../signer/index.js";
import type {
  GatewayRequestStorePort,
  GatewaySolanaSplitRequest,
} from "./types.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function canonicalHash(request: GatewaySolanaSplitRequest): string {
  return createHash("sha256").update(JSON.stringify([
    "ALPHABASKET_REMOTE_SOLANA_SPLIT_V1",
    request.deploymentMode,
    request.idempotencyKey,
    request.sourceBridgeTransaction ?? "none",
    (request.sourceBridgeAmountUnits ?? 0n).toString(10),
    [...(request.sourceJupiterTransactions ?? [])].sort(),
    (request.idleUsdcAmountUnits ?? 0n).toString(10),
    request.mint,
    request.userDestination,
    request.creatorDestination,
    request.protocolDestination,
    request.userAmountUnits.toString(10),
    request.creatorAmountUnits.toString(10),
    request.protocolAmountUnits.toString(10),
  ]), "utf8").digest("hex");
}

function associatedToken(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function createAssociatedTokenIdempotent(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  ata: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

function transferChecked(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
): TransactionInstruction {
  if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("SPL transfer amount is outside u64");
  }
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface SolanaUsdcSplitOptions {
  readonly deploymentMode: GatewaySolanaSplitRequest["deploymentMode"];
  readonly sourceOwner: PublicKey;
  readonly usdcMint: PublicKey;
  readonly maximumSplitUnits: bigint;
  readonly maximumNetworkFeeLamports: bigint;
  readonly expectedDecimals?: number;
  readonly now?: () => Date;
}

export class SolanaUsdcSplitGateway {
  private readonly now: () => Date;
  private readonly bridgeReceipt: Web3SolanaBridgeReceiptVerifier;

  public constructor(
    private readonly store: GatewayRequestStorePort,
    private readonly signer: PolicyEnforcedSigner,
    private readonly connection: Connection,
    private readonly options: SolanaUsdcSplitOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.bridgeReceipt = new Web3SolanaBridgeReceiptVerifier(connection);
    if (options.maximumSplitUnits <= 0n || options.maximumNetworkFeeLamports <= 0n) {
      throw new RangeError("Solana split limits must be positive");
    }
  }

  public async splitSolanaUsdc(request: GatewaySolanaSplitRequest): Promise<{
    readonly requestHash: string;
    readonly transactionSignature: string;
    readonly finalizedSlot: bigint;
  }> {
    const total = this.validate(request);
    const hash = canonicalHash(request);
    if (hash !== request.requestHash) {
      throw new Error("Solana split request hash does not match its canonical content");
    }
    const capitalSources = await this.validateSources(request, total);
    const requestKey = `solana-split:${request.idempotencyKey}`;
    const prepared = await this.store.prepare({
      requestKey,
      requestKind: "solana_split",
      requestHash: hash,
      build: async () => this.buildSignedSplit(request),
      now: this.now(),
    });
    await this.store.claimCapitalSources({
      requestKey,
      requestHash: hash,
      sources: capitalSources,
      now: this.now(),
    });
    const transactionSignature = prepared.transactionReference;
    if (transactionSignature === null) {
      throw new Error("journaled Solana split is missing its transaction signature");
    }
    if (prepared.state === "finalized") {
      const slot = prepared.result?.finalizedSlot;
      if (typeof slot !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(slot)) {
        throw new Error("finalized Solana split journal is malformed");
      }
      return Object.freeze({
        requestHash: hash,
        transactionSignature,
        finalizedSlot: BigInt(slot),
      });
    }
    const statuses = await this.connection.getSignatureStatuses(
      [transactionSignature],
      { searchTransactionHistory: true },
    );
    let status = statuses.value[0] ?? null;
    if (status === null) {
      const submitted = await this.connection.sendRawTransaction(
        Buffer.from(prepared.signedPayload),
        { skipPreflight: false, maxRetries: 3 },
      );
      if (submitted !== transactionSignature) {
        throw new Error("Solana RPC returned a signature different from the journaled split");
      }
      await this.store.markSubmitted(requestKey, transactionSignature, this.now());
      const confirmation = await this.connection.confirmTransaction(
        transactionSignature,
        "finalized",
      );
      if (confirmation.value.err !== null) throw new Error("Solana mainnet split transaction failed");
      status = {
        slot: confirmation.context.slot,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized",
      };
    }
    if (
      status === null ||
      status.err !== null ||
      status.confirmationStatus !== "finalized"
    ) {
      throw new Error("Solana mainnet split is not finalized successfully");
    }
    const finalizedSlot = BigInt(status.slot);
    await this.store.markFinalized(requestKey, transactionSignature, {
      transactionSignature,
      finalizedSlot: finalizedSlot.toString(10),
    }, this.now());
    return Object.freeze({ requestHash: hash, transactionSignature, finalizedSlot });
  }

  private validate(request: GatewaySolanaSplitRequest): bigint {
    if (request.deploymentMode !== this.options.deploymentMode) {
      throw new Error("Solana split deployment mode does not match the gateway");
    }
    if (!/^[A-Za-z0-9_.:-]{8,128}$/u.test(request.idempotencyKey)) {
      throw new TypeError("Solana split idempotency key is invalid");
    }
    if (request.mint !== this.options.usdcMint.toBase58()) {
      throw new Error("Solana split mint is not the configured mainnet USDC mint");
    }
    const destinations = [
      request.userDestination,
      request.creatorDestination,
      request.protocolDestination,
    ].map((value) => new PublicKey(value));
    if (destinations.some((value) => value.equals(this.options.sourceOwner))) {
      throw new Error("Solana split cannot claim a fee or payout to its source owner");
    }
    const amounts = [
      request.userAmountUnits,
      request.creatorAmountUnits,
      request.protocolAmountUnits,
    ];
    if (amounts.some((value) => value < 0n)) {
      throw new RangeError("Solana split amounts must be non-negative");
    }
    const total = amounts.reduce((sum, value) => sum + value, 0n);
    if (total <= 0n || total > this.options.maximumSplitUnits) {
      throw new RangeError("Solana split exceeds the gateway amount policy");
    }
    return total;
  }

  private async validateSources(
    request: GatewaySolanaSplitRequest,
    total: bigint,
  ): Promise<readonly Readonly<{
    kind: "bridge_receipt" | "jupiter_swap";
    reference: string;
    amountUnits: bigint;
  }>[]> {
    const bridgeAmount = request.sourceBridgeAmountUnits ??
      (request.sourceBridgeTransaction === null ? 0n : total);
    const idleAmount = request.idleUsdcAmountUnits ?? 0n;
    if (bridgeAmount < 0n || idleAmount < 0n) {
      throw new RangeError("Solana split source amounts must be non-negative");
    }
    if ((request.sourceBridgeTransaction === null) !== (bridgeAmount === 0n)) {
      throw new Error("Solana split bridge proof and amount must either both be present or absent");
    }
    if (request.sourceBridgeTransaction !== null) {
      const receipt = await this.bridgeReceipt.verifyReceived({
        bridgeAddress: request.sourceBridgeTransaction,
        destination: this.options.sourceOwner.toBase58(),
        mint: this.options.usdcMint.toBase58(),
        expectedMaximumUnits: bridgeAmount,
        destinationTransactionHash: request.sourceBridgeTransaction,
      });
      if (receipt.amountUnits !== bridgeAmount) {
        throw new Error("Solana split bridge amount does not equal its finalized receipt");
      }
    }
    const capitalSources: {
      kind: "bridge_receipt" | "jupiter_swap";
      reference: string;
      amountUnits: bigint;
    }[] = request.sourceBridgeTransaction === null
      ? []
      : [{
          kind: "bridge_receipt",
          reference: request.sourceBridgeTransaction,
          amountUnits: bridgeAmount,
        }];
    const references = request.sourceJupiterTransactions ?? [];
    if (new Set(references).size !== references.length) {
      throw new Error("Solana split contains duplicate Jupiter transaction proofs");
    }
    let jupiterAmount = 0n;
    for (const reference of references) {
      const prepared = await this.store.findFinalizedByTransactionReference?.(
        "jupiter_swap",
        reference,
      );
      if (prepared === undefined || prepared === null) {
        throw new Error("Solana split Jupiter source is absent from the finalized gateway journal");
      }
      const outputMint = prepared.result?.outputMint;
      const output = prepared.result?.filledOutputUnits;
      if (
        outputMint !== this.options.usdcMint.toBase58() ||
        typeof output !== "string" ||
        !/^[1-9][0-9]*$/u.test(output)
      ) {
        throw new Error("Solana split Jupiter source journal is malformed or not USDC");
      }
      const amount = BigInt(output);
      jupiterAmount += amount;
      capitalSources.push({
        kind: "jupiter_swap",
        reference,
        amountUnits: amount,
      });
    }
    if (bridgeAmount + jupiterAmount + idleAmount !== total) {
      throw new Error("Solana split outputs do not reconcile with finalized hybrid sources");
    }
    return Object.freeze(capitalSources.map((source) =>
      Object.freeze(source),
    ));
  }

  private async buildSignedSplit(
    request: GatewaySolanaSplitRequest,
  ): Promise<{ readonly signedPayload: Uint8Array; readonly transactionReference: string }> {
    const mintInfo = await this.connection.getParsedAccountInfo(this.options.usdcMint, "confirmed");
    const parsed = mintInfo.value?.data;
    if (
      parsed === undefined ||
      Buffer.isBuffer(parsed) ||
      typeof parsed !== "object" ||
      !("parsed" in parsed)
    ) {
      throw new Error("configured mainnet USDC mint is not a parsed SPL mint");
    }
    const decimals = (parsed.parsed as { readonly info?: { readonly decimals?: unknown } }).info?.decimals;
    if (
      typeof decimals !== "number" ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 18 ||
      (this.options.expectedDecimals !== undefined && decimals !== this.options.expectedDecimals)
    ) {
      throw new Error("configured mainnet USDC mint decimals do not match policy");
    }
    const recipients = new Map<string, bigint>();
    const pairs = [
      [request.userDestination, request.userAmountUnits],
      [request.creatorDestination, request.creatorAmountUnits],
      [request.protocolDestination, request.protocolAmountUnits],
    ] as const;
    for (const [destination, amount] of pairs) {
      if (amount === 0n) continue;
      recipients.set(destination, (recipients.get(destination) ?? 0n) + amount);
    }
    const sourceAta = associatedToken(this.options.sourceOwner, this.options.usdcMint);
    const transaction = new Transaction();
    for (const [destination, amount] of recipients) {
      const owner = new PublicKey(destination);
      const destinationAta = associatedToken(owner, this.options.usdcMint);
      transaction.add(
        createAssociatedTokenIdempotent(
          this.options.sourceOwner,
          owner,
          this.options.usdcMint,
          destinationAta,
        ),
        transferChecked(
          sourceAta,
          this.options.usdcMint,
          destinationAta,
          this.options.sourceOwner,
          amount,
          decimals,
        ),
      );
    }
    const blockhash = await this.connection.getLatestBlockhash("finalized");
    transaction.feePayer = this.options.sourceOwner;
    transaction.recentBlockhash = blockhash.blockhash;
    const fee = await this.connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
    if (
      fee.value === null ||
      BigInt(fee.value) <= 0n ||
      BigInt(fee.value) > this.options.maximumNetworkFeeLamports
    ) {
      throw new Error("Solana mainnet fee quote violates the gateway fee policy");
    }
    const message = transaction.serializeMessage();
    const signed = await this.signer.sign({
      role: "solana_settlement",
      payload: message,
      context: {
        domain: "alphabasket:solana-capital-transaction:v1",
        action: "split_withdrawal_usdc",
        network: "solana-mainnet-beta",
        expiresAt: new Date(this.now().getTime() + 60_000),
        intentHash: request.requestHash,
      },
    });
    transaction.addSignature(this.options.sourceOwner, Buffer.from(signed.signature));
    if (!transaction.verifySignatures()) {
      throw new Error("remote Solana settlement signature is invalid");
    }
    const raw = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
    return Object.freeze({
      signedPayload: Uint8Array.from(raw),
      transactionReference: bs58.encode(signed.signature),
    });
  }
}
