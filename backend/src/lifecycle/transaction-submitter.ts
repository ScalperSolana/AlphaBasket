import { createHash } from "node:crypto";

import bs58 from "bs58";
import {
  Connection,
  Ed25519Program,
  Message,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import type { PolicyEnforcedSigner } from "../signer/policy-signer.js";
import type { SignerRole } from "../signer/types.js";
import type {
  LifecycleInstructionBatch,
  LifecycleTransactionResult,
  LifecycleTransactionSubmitterPort,
} from "./types.js";
import type {
  LifecycleSubmissionAttempt,
  LifecycleSubmissionOperation,
  LifecycleTransactionJournalPort,
} from "./transaction-journal.js";

const encodeU32 = (value: number): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new RangeError("value is not u32");
  const encoded = Buffer.allocUnsafe(4);
  encoded.writeUInt32LE(value);
  return encoded;
};

const encodeBytes = (value: Uint8Array): Buffer => Buffer.concat([encodeU32(value.byteLength), Buffer.from(value)]);

function canonicalInstruction(instruction: TransactionInstruction): Buffer {
  return Buffer.concat([
    instruction.programId.toBuffer(),
    encodeU32(instruction.keys.length),
    ...instruction.keys.map((key) => Buffer.concat([
      key.pubkey.toBuffer(),
      Buffer.from([key.isSigner ? 1 : 0, key.isWritable ? 1 : 0]),
    ])),
    encodeBytes(instruction.data),
  ]);
}

/** Commits to ordered instructions and the complete required signer set. */
export function lifecycleInstructionBatchHash(batch: LifecycleInstructionBatch): string {
  if (batch.instructions.length === 0) throw new RangeError("lifecycle transaction batch must contain instructions");
  const signerKeys = [...new Set(batch.requiredSignerPublicKeys.map((key) => key.toBase58()))].sort();
  return createHash("sha256").update(Buffer.concat([
    Buffer.from("ALPHABASKET_SOLANA_LIFECYCLE_BATCH_V1", "ascii"),
    encodeU32(batch.instructions.length),
    ...batch.instructions.map(canonicalInstruction),
    encodeU32(signerKeys.length),
    ...signerKeys.map((key) => new PublicKey(key).toBuffer()),
  ])).digest("hex");
}

const allowedLifecycleDiscriminators = new Set([
  "accrue_management_fee",
  "begin_reconstitution",
  "complete_reconstitution",
  "begin_resolution",
  "record_final_settlement",
].map((name) => createHash("sha256").update(`global:${name}`, "utf8").digest().subarray(0, 8).toString("hex")));

/** Defense-in-depth validator installed on each lifecycle KMS signer policy. */
export function validateSolanaLifecycleMessage(
  payload: Uint8Array,
  signerPublicKey: PublicKey,
  programId: PublicKey,
): void {
  const message = Message.from(payload);
  const signerIndex = message.accountKeys.findIndex((key) => key.equals(signerPublicKey));
  if (signerIndex < 0 || signerIndex >= message.header.numRequiredSignatures) {
    throw new Error("configured key is not a required signer in the Solana message");
  }
  if (message.instructions.length === 0) throw new Error("Solana lifecycle message contains no instructions");
  let lifecycleInstructions = 0;
  for (const instruction of message.instructions) {
    const instructionProgram = message.accountKeys[instruction.programIdIndex];
    if (instructionProgram === undefined) throw new Error("Solana message has an invalid program index");
    if (instructionProgram.equals(Ed25519Program.programId)) continue;
    if (!instructionProgram.equals(programId)) throw new Error(`Solana lifecycle message invokes unapproved program ${instructionProgram.toBase58()}`);
    const data = Buffer.from(bs58.decode(instruction.data));
    if (data.byteLength < 8 || !allowedLifecycleDiscriminators.has(data.subarray(0, 8).toString("hex"))) {
      throw new Error("Solana lifecycle message invokes an unapproved AlphaBasket instruction");
    }
    lifecycleInstructions += 1;
  }
  if (lifecycleInstructions !== 1) throw new Error("Solana lifecycle message must contain exactly one AlphaBasket instruction");
}

export interface KmsLifecycleTransactionSubmitterOptions {
  readonly feePayer: PublicKey;
  readonly signerRoleByPublicKey: ReadonlyMap<string, SignerRole>;
  readonly network: "localnet" | "devnet" | "mainnet-beta";
  readonly programId: PublicKey;
  readonly maximumBlockhashAttempts?: number;
  readonly now?: () => Date;
}

/**
 * Journals a fully signed transaction before broadcast. Replays resend the exact
 * bytes, while an expired blockhash is replaced only after RPC proves the old
 * signature did not land.
 */
export class KmsLifecycleTransactionSubmitter implements LifecycleTransactionSubmitterPort {
  private readonly maximumBlockhashAttempts: number;
  private readonly now: () => Date;

  public constructor(
    private readonly connection: Connection,
    private readonly signer: PolicyEnforcedSigner,
    private readonly journal: LifecycleTransactionJournalPort,
    private readonly options: KmsLifecycleTransactionSubmitterOptions,
  ) {
    this.maximumBlockhashAttempts = options.maximumBlockhashAttempts ?? 3;
    if (!Number.isSafeInteger(this.maximumBlockhashAttempts) || this.maximumBlockhashAttempts < 1 || this.maximumBlockhashAttempts > 8) {
      throw new RangeError("maximum blockhash attempts must be between 1 and 8");
    }
    this.now = options.now ?? (() => new Date());
  }

  public async submit(batch: LifecycleInstructionBatch): Promise<LifecycleTransactionResult> {
    if (batch.operationKey.length === 0 || batch.operationKey.length > 256) throw new RangeError("invalid lifecycle operation key");
    const batchHash = lifecycleInstructionBatchHash(batch);
    let operation = await this.journal.createOrLoad(batch.operationKey, batchHash, this.now());
    if (operation.state === "finalized") return this.finalizedResult(operation);
    if (operation.state === "failed") throw new Error(operation.lastError ?? "lifecycle transaction was rejected");

    for (let freshAttempts = 0; freshAttempts < this.maximumBlockhashAttempts; freshAttempts += 1) {
      let attempt = await this.journal.latestAttempt(operation.id);
      if (attempt === null || attempt.state === "expired") {
        operation = await this.journal.createOrLoad(batch.operationKey, batchHash, this.now());
        try {
          attempt = await this.createSignedAttempt(operation, batch, batchHash);
        } catch (error) {
          if (!(error instanceof Error) || !/version conflict/u.test(error.message)) throw error;
          attempt = await this.journal.latestAttempt(operation.id);
          if (attempt === null) throw error;
        }
      }
      if (attempt.state === "finalized") {
        operation = await this.journal.createOrLoad(batch.operationKey, batchHash, this.now());
        return this.finalizedResult(operation);
      }
      if (attempt.state === "rejected") throw new Error(attempt.lastError ?? "lifecycle transaction was rejected");

      const observed = await this.observeSignature(operation, attempt);
      if (observed !== null) return observed;

      const currentHeight = BigInt(await this.connection.getBlockHeight("confirmed"));
      if (currentHeight > attempt.lastValidBlockHeight) {
        await this.journal.markExpired(operation.id, attempt.attemptNumber, "recent blockhash expired before finalization", this.now());
        continue;
      }

      const returnedSignature = await this.connection.sendRawTransaction(attempt.serializedTransaction, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });
      if (returnedSignature !== attempt.transactionSignature) {
        throw new Error("Solana RPC returned a signature different from the journaled transaction");
      }
      attempt = await this.journal.markSubmitted(operation.id, attempt.attemptNumber, this.now());
      let confirmation;
      try {
        confirmation = await this.connection.confirmTransaction({
          signature: attempt.transactionSignature,
          blockhash: attempt.recentBlockhash,
          lastValidBlockHeight: Number(attempt.lastValidBlockHeight),
        }, "finalized");
      } catch (error) {
        const afterConfirmation = await this.observeSignature(operation, attempt);
        if (afterConfirmation !== null) return afterConfirmation;
        const height = BigInt(await this.connection.getBlockHeight("confirmed"));
        if (height > attempt.lastValidBlockHeight) {
          await this.journal.markExpired(
            operation.id,
            attempt.attemptNumber,
            error instanceof Error ? error.message : "blockhash expired during confirmation",
            this.now(),
          );
          continue;
        }
        throw error;
      }
      if (confirmation.value.err !== null) {
        const reason = JSON.stringify(confirmation.value.err);
        await this.journal.markRejected(operation.id, attempt.attemptNumber, reason, this.now());
        throw new Error(`lifecycle transaction rejected by Solana: ${reason}`);
      }

      const finalized = await this.observeSignature(operation, attempt);
      if (finalized !== null) return finalized;
      throw new Error("Solana confirmation returned without a finalized signature status");
    }
    throw new Error("lifecycle transaction exhausted fresh blockhash attempts");
  }

  private async createSignedAttempt(
    operation: LifecycleSubmissionOperation,
    batch: LifecycleInstructionBatch,
    batchHash: string,
  ): Promise<LifecycleSubmissionAttempt> {
    const latest = await this.connection.getLatestBlockhash("finalized");
    const transaction = new Transaction({
      feePayer: this.options.feePayer,
      recentBlockhash: latest.blockhash,
    });
    transaction.add(...batch.instructions);
    const signerKeys = new Map<string, PublicKey>();
    signerKeys.set(this.options.feePayer.toBase58(), this.options.feePayer);
    for (const key of batch.requiredSignerPublicKeys) signerKeys.set(key.toBase58(), key);
    const message = transaction.serializeMessage();
    const expiresAt = new Date(this.now().getTime() + 120_000);
    for (const [address, key] of signerKeys) {
      const role = this.options.signerRoleByPublicKey.get(address);
      if (role === undefined) throw new Error(`no KMS signer role configured for ${address}`);
      const signature = await this.signer.sign({
        role,
        payload: message,
        context: {
          domain: "alphabasket:solana-transaction:v1",
          action: "submit_lifecycle_transaction",
          network: this.options.network,
          expiresAt,
          programId: this.options.programId.toBase58(),
          intentHash: batchHash,
        },
      });
      if (!Buffer.from(signature.publicKey).equals(key.toBuffer())) throw new Error(`KMS signer returned the wrong public key for ${address}`);
      transaction.addSignature(key, Buffer.from(signature.signature));
    }
    if (!transaction.verifySignatures()) throw new Error("KMS signatures do not satisfy the Solana transaction message");
    const serialized = transaction.serialize({ requireAllSignatures: true, verifySignatures: true });
    const feePayerSignature = transaction.signature;
    if (feePayerSignature === null) throw new Error("signed transaction is missing the fee-payer signature");
    return this.journal.appendSignedAttempt({
      operationId: operation.id,
      expectedOperationVersion: operation.version,
      transactionSignature: bs58.encode(feePayerSignature),
      serializedTransaction: serialized,
      recentBlockhash: latest.blockhash,
      lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
      now: this.now(),
    });
  }

  private async observeSignature(
    operation: LifecycleSubmissionOperation,
    attempt: LifecycleSubmissionAttempt,
  ): Promise<LifecycleTransactionResult | null> {
    const response = await this.connection.getSignatureStatuses(
      [attempt.transactionSignature],
      { searchTransactionHistory: true },
    );
    const status = response.value[0];
    if (status === null || status === undefined) return null;
    if (status.err !== null) {
      const reason = JSON.stringify(status.err);
      if (attempt.state !== "rejected") await this.journal.markRejected(operation.id, attempt.attemptNumber, reason, this.now());
      throw new Error(`lifecycle transaction rejected by Solana: ${reason}`);
    }
    if (status.confirmationStatus !== "finalized") return null;
    const finalized = await this.journal.markFinalized(
      operation.id,
      attempt.attemptNumber,
      attempt.transactionSignature,
      BigInt(status.slot),
      this.now(),
    );
    return this.finalizedResult(finalized);
  }

  private finalizedResult(operation: LifecycleSubmissionOperation): LifecycleTransactionResult {
    if (operation.state !== "finalized" || operation.finalizedSignature === undefined || operation.finalizedSlot === undefined) {
      throw new Error("finalized lifecycle operation is missing its result");
    }
    return Object.freeze({
      transactionSignature: operation.finalizedSignature,
      finalizedSlot: operation.finalizedSlot,
    });
  }
}
