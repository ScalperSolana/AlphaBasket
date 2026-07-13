import type { Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import {
  ALPHABASKET_PROGRAM_ID,
  EXECUTION_BATCH_VERSION,
  deriveConfigPda,
  derivePositionPda,
  deriveReceiptPda,
} from "../contract/index.js";
import type { PolybasketsEscrow } from "../contract/generated/polybaskets_escrow.js";
import type { SettlementResult } from "../execution/types.js";
import type {
  CompleteDepositRequest,
  CompleteProtocolFeeWithdrawalRequest,
  CompleteWithdrawalRequest,
  SolanaSettlementGatewayPort,
} from "./types.js";

export class AnchorSettlementGateway implements SolanaSettlementGatewayPort {
  public constructor(private readonly program: Program<PolybasketsEscrow>) {
    if (!program.programId.equals(ALPHABASKET_PROGRAM_ID)) throw new TypeError("Anchor program ID does not match AlphaBasket");
  }

  public async completeDeposit(request: CompleteDepositRequest): Promise<SettlementResult> {
    const quote = request.intent.quote;
    const [config] = deriveConfigPda(this.program.programId);
    const basket = quote.basket;
    const [position] = derivePositionPda(basket, quote.user, this.program.programId);
    const [receipt] = deriveReceiptPda(request.executionBatchHash, this.program.programId);
    const existing = await this.existingResult(receipt, request.executionBatchHash);
    if (existing !== undefined) return existing;
    const instruction = await this.program.methods.completeDeposit({
      user: quote.user,
      intentNonce: request.intent.nonce,
      intentExpiry: quote.expiresAtSeconds,
      expectedCompositionVersion: quote.compositionVersion,
      grossAmount: quote.grossAmount,
      minSharesOut: quote.minSharesOut,
      quoteHash: [...quote.quoteHash],
      executionVersion: EXECUTION_BATCH_VERSION,
      executionBatchHash: [...request.executionBatchHash],
      executedAt: request.executedAtSeconds,
      navReportHash: [...request.navReportHash],
      settlementNonce: request.settlementNonce,
      basketNavValue: request.basketNavValue,
      sharePrice: request.sharePrice,
      netDepositValue: request.netDepositValue,
      sharesCredited: request.sharesCredited,
      protocolFee: request.protocolFee,
    }).accountsStrict({
      config,
      basket,
      position,
      receipt,
      backendSigner: this.requireProviderKey(),
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    }).instruction();
    return this.sendWithIntent(quote.user.toBytes(), request.intent.encodedMessage, request.intent.signature, instruction, receipt);
  }

  public async completeWithdrawal(request: CompleteWithdrawalRequest): Promise<SettlementResult> {
    const quote = request.intent.quote;
    const [config] = deriveConfigPda(this.program.programId);
    const basket = quote.basket;
    const [position] = derivePositionPda(basket, quote.user, this.program.programId);
    const [receipt] = deriveReceiptPda(request.executionBatchHash, this.program.programId);
    const existing = await this.existingResult(receipt, request.executionBatchHash);
    if (existing !== undefined) return existing;
    const instruction = await this.program.methods.completeWithdrawal({
      user: quote.user,
      intentNonce: request.intent.nonce,
      intentExpiry: quote.expiresAtSeconds,
      expectedCompositionVersion: quote.compositionVersion,
      shareAmount: quote.shareAmount,
      minValueOut: quote.minValueOut,
      destination: request.intent.destination,
      quoteHash: [...quote.quoteHash],
      executionVersion: EXECUTION_BATCH_VERSION,
      executionBatchHash: [...request.executionBatchHash],
      executedAt: request.executedAtSeconds,
      navReportHash: [...request.navReportHash],
      settlementNonce: request.settlementNonce,
      basketNavValue: request.basketNavValue,
      sharePrice: request.sharePrice,
      grossRealizedValue: request.grossRealizedValue,
      protocolFee: request.protocolFee,
      creatorFee: request.creatorFee,
      userValueOut: request.userValueOut,
    }).accountsStrict({
      config,
      basket,
      position,
      receipt,
      backendSigner: this.requireProviderKey(),
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    }).instruction();
    return this.sendWithIntent(quote.user.toBytes(), request.intent.encodedMessage, request.intent.signature, instruction, receipt);
  }

  public async completeProtocolFeeWithdrawal(request: CompleteProtocolFeeWithdrawalRequest): Promise<SettlementResult> {
    const [config] = deriveConfigPda(this.program.programId);
    const [receipt] = deriveReceiptPda(request.executionBatchHash, this.program.programId);
    const existing = await this.existingResult(receipt, request.executionBatchHash);
    if (existing !== undefined) return existing;
    const instruction = await this.program.methods.completeProtocolFeeWithdrawal({
      executionVersion: EXECUTION_BATCH_VERSION,
      executionBatchHash: [...request.executionBatchHash],
      executedAt: request.executedAtSeconds,
      navReportHash: [...request.navReportHash],
      settlementNonce: request.settlementNonce,
      shareAmount: request.shareAmount,
      basketNavValue: request.basketNavValue,
      sharePrice: request.sharePrice,
      grossRealizedValue: request.grossRealizedValue,
    }).accountsStrict({
      config,
      basket: request.basket,
      receipt,
      backendSigner: this.requireProviderKey(),
      systemProgram: SystemProgram.programId,
    }).instruction();
    return this.send(new Transaction().add(instruction), receipt);
  }

  private requireProviderKey() {
    const key = this.program.provider.publicKey;
    if (key === undefined) throw new TypeError("Anchor provider is missing the backend signer");
    return key;
  }

  private async sendWithIntent(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array, instruction: Parameters<Transaction["add"]>[0], receipt: PublicKey): Promise<SettlementResult> {
    if (signature.byteLength !== 64) throw new TypeError("invalid user Ed25519 signature");
    const verifyInstruction = Ed25519Program.createInstructionWithPublicKey({ publicKey, message, signature });
    return this.send(new Transaction().add(verifyInstruction, instruction), receipt);
  }

  private async send(transaction: Transaction, receipt: PublicKey): Promise<SettlementResult> {
    const sendAndConfirm = this.program.provider.sendAndConfirm;
    if (sendAndConfirm === undefined) throw new TypeError("Anchor provider does not support transaction submission");
    const signature = await sendAndConfirm.call(this.program.provider, transaction, []);
    await this.program.provider.connection.confirmTransaction(signature, "finalized");
    const status = await this.program.provider.connection.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err !== null || status.value.confirmationStatus !== "finalized") throw new Error("settlement transaction is not finalized successfully");
    return Object.freeze({ transactionSignature: signature, receiptAddress: receipt.toBase58(), finalizedSlot: BigInt(status.context.slot) });
  }

  private async existingResult(receipt: PublicKey, expectedHash: Uint8Array): Promise<SettlementResult | undefined> {
    const account = await this.program.provider.connection.getAccountInfo(receipt, "finalized");
    if (account === null) return undefined;
    if (!account.owner.equals(this.program.programId)) throw new Error("settlement receipt PDA is owned by an unexpected program");
    const decoded = this.program.coder.accounts.decode("SettlementReceipt", account.data) as { executionBatchHash?: readonly number[] | Uint8Array };
    const actual = decoded.executionBatchHash;
    if (actual === undefined || !Buffer.from(actual).equals(Buffer.from(expectedHash))) {
      throw new Error("existing settlement receipt does not match the execution batch");
    }
    const signatures = await this.program.provider.connection.getSignaturesForAddress(receipt, { limit: 1 }, "finalized");
    const finalized = signatures[0];
    if (finalized === undefined || finalized.err !== null || finalized.confirmationStatus !== "finalized") {
      throw new Error("existing settlement receipt has no finalized creation transaction");
    }
    return Object.freeze({
      transactionSignature: finalized.signature,
      receiptAddress: receipt.toBase58(),
      finalizedSlot: BigInt(finalized.slot),
    });
  }
}
