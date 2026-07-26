import type { Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";

import {
  ALPHABASKET_PROGRAM_ID,
  compositionHash as hashComposition,
  deriveCompositionDraftPda,
  deriveConfigPda,
  deriveEligibilityListPda,
  deriveTokenAllowlistPda,
  eligibilityHash as hashEligibility,
  reconstitutionAuthorizationMessage,
} from "../contract/index.js";
import type { PolybasketsEscrow } from "../contract/generated/polybaskets_escrow.js";
import type {
  FinalSettlementRequest,
  FinalSettlementResult,
  LifecycleBasketSourcePort,
  LifecycleSolanaGatewayPort,
  LifecycleTransactionResult,
  LifecycleTransactionSubmitterPort,
  SignedReconstitution,
} from "./types.js";

export interface AnchorLifecycleGatewayOptions {
  readonly backendSigner: PublicKey;
  readonly composerSigner: PublicKey;
  readonly finalSettlementAttempts?: number;
  /** Return true only for the program's optimistic final-share-snapshot race error. */
  readonly isFinalSnapshotRace?: (error: unknown) => boolean;
}

const requireBytes = (value: Uint8Array, length: number, name: string): Uint8Array => {
  if (value.byteLength !== length) throw new TypeError(`${name} must be ${length} bytes`);
  return Uint8Array.from(value);
};

/** Builds the exact Anchor instructions; signing/submission is delegated to a KMS-capable boundary. */
export class AnchorLifecycleGateway implements LifecycleSolanaGatewayPort {
  private readonly config: PublicKey;
  private readonly finalSettlementAttempts: number;
  private readonly isFinalSnapshotRace: (error: unknown) => boolean;

  public constructor(
    private readonly program: Program<PolybasketsEscrow>,
    private readonly submitter: LifecycleTransactionSubmitterPort,
    private readonly baskets: LifecycleBasketSourcePort,
    private readonly options: AnchorLifecycleGatewayOptions,
  ) {
    if (!program.programId.equals(ALPHABASKET_PROGRAM_ID)) throw new TypeError("Anchor program ID does not match AlphaBasket");
    [this.config] = deriveConfigPda(program.programId);
    this.finalSettlementAttempts = options.finalSettlementAttempts ?? 3;
    if (!Number.isSafeInteger(this.finalSettlementAttempts) || this.finalSettlementAttempts <= 0 || this.finalSettlementAttempts > 5) {
      throw new RangeError("final settlement attempts must be between 1 and 5");
    }
    this.isFinalSnapshotRace = options.isFinalSnapshotRace ?? ((error: unknown): boolean =>
      error instanceof Error && /FinalSnapshotMismatch|final share snapshot/i.test(error.message));
  }

  public async accrueManagementFee(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult> {
    const instruction = await this.program.methods.accrueManagementFee().accountsStrict({
      config: this.config,
      basket,
    }).instruction();
    return this.submitter.submit(Object.freeze({
      operationKey,
      instructions: Object.freeze([instruction]),
      requiredSignerPublicKeys: Object.freeze([]),
    }));
  }

  public async beginReconstitution(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult> {
    const instruction = await this.program.methods.beginReconstitution().accountsStrict({
      config: this.config,
      basket,
      backendSigner: this.options.backendSigner,
    }).instruction();
    return this.submitter.submit(Object.freeze({
      operationKey,
      instructions: Object.freeze([instruction]),
      requiredSignerPublicKeys: Object.freeze([this.options.backendSigner]),
    }));
  }

  public async completeReconstitution(request: SignedReconstitution, operationKey: string): Promise<LifecycleTransactionResult> {
    const current = await this.baskets.loadBasket(request.basket);
    if (!current.address.equals(request.basket)) throw new Error("basket source returned a different account");
    if (!current.isPerpetual || current.status !== "reconstituting") {
      throw new Error("basket is not in the reconstituting lifecycle state");
    }
    if (!Buffer.from(requireBytes(request.basketId, 32, "basketId")).equals(Buffer.from(current.basketId))) {
      throw new Error("reconstitution basket ID does not match the on-chain basket");
    }
    if (request.nextCompositionVersion !== current.compositionVersion + 1) {
      throw new Error("reconstitution composition version is stale");
    }
    if (request.compositionNonce <= current.lastCompositionNonce) {
      throw new Error("reconstitution composition nonce is stale");
    }
    const publicKeyBytes = requireBytes(request.composerPublicKey, 32, "composerPublicKey");
    const signature = requireBytes(request.composerSignature, 64, "composerSignature");
    const composerSigner = new PublicKey(publicKeyBytes);
    if (!composerSigner.equals(this.options.composerSigner)) {
      throw new Error("reconstitution was signed by an unexpected Composer key");
    }
    const expectedCompositionHash = hashComposition(request.items);
    const suppliedCompositionHash = requireBytes(request.compositionHash, 32, "compositionHash");
    if (!expectedCompositionHash.equals(Buffer.from(suppliedCompositionHash))) {
      throw new Error("reconstitution composition hash does not match its items");
    }
    const expectedEligibilityHash = hashEligibility(request.eligibleMarkets);
    const suppliedEligibilityHash = requireBytes(
      request.eligibilityHash,
      32,
      "eligibilityHash",
    );
    if (!expectedEligibilityHash.equals(Buffer.from(suppliedEligibilityHash))) {
      throw new Error("reconstitution eligibility hash does not match its markets");
    }
    const expectedMessage = reconstitutionAuthorizationMessage({
      basketId: request.basketId,
      nextCompositionVersion: request.nextCompositionVersion,
      eligibilityHash: suppliedEligibilityHash,
      eligibilityNonce: request.eligibilityNonce,
      compositionNonce: request.compositionNonce,
      compositionExpiry: request.compositionExpirySeconds,
      programId: this.program.programId,
    });
    const encodedMessage = requireBytes(request.encodedMessage, expectedMessage.byteLength, "encodedMessage");
    if (!expectedMessage.equals(Buffer.from(encodedMessage))) {
      throw new Error("reconstitution authorization message is not canonical");
    }
    const verify = Ed25519Program.createInstructionWithPublicKey({
      publicKey: publicKeyBytes,
      message: encodedMessage,
      signature,
    });
    const [eligibilityList] = deriveEligibilityListPda(
      suppliedEligibilityHash,
      request.eligibilityNonce,
      this.program.programId,
    );
    const existingEligibility =
      await this.program.provider.connection.getAccountInfo(
        eligibilityList,
        "confirmed",
      );
    if (existingEligibility === null) {
      const publish = await this.program.methods
        .publishEligibilityList({
          listHash: [...suppliedEligibilityHash],
          nonce: request.eligibilityNonce,
          expiresAt: request.compositionExpirySeconds,
          markets: request.eligibleMarkets.map((market) => ({
            marketId: market.marketId,
            outcome: market.outcome,
            ctfTokenId: [...requireBytes(market.ctfTokenId, 32, "eligible ctfTokenId")],
          })),
        })
        .accountsStrict({
          config: this.config,
          eligibilityList,
          composerSigner,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      await this.submitter.submit(Object.freeze({
        operationKey: `${operationKey}:eligibility`,
        instructions: Object.freeze([publish]),
        requiredSignerPublicKeys: Object.freeze([composerSigner]),
      }));
    } else if (!existingEligibility.owner.equals(this.program.programId)) {
      throw new Error("reconstitution eligibility PDA has an unexpected owner");
    }
    const hasSpot = request.items.some((item) => "spot" in item.kind);
    const spotAllowlistAccounts = hasSpot
      ? [{
          pubkey: deriveTokenAllowlistPda(this.program.programId)[0],
          isSigner: false,
          isWritable: false,
        }]
      : [];
    const [compositionDraft] = deriveCompositionDraftPda(
      suppliedCompositionHash,
      request.compositionNonce,
      this.program.programId,
    );
    const existingDraft =
      await this.program.provider.connection.getAccountInfo(
        compositionDraft,
        "confirmed",
      );
    if (existingDraft === null) {
      let draftBuilder = this.program.methods
        .publishCompositionDraft({
          compositionHash: [...suppliedCompositionHash],
          eligibilityHash: [...suppliedEligibilityHash],
          eligibilityNonce: request.eligibilityNonce,
          compositionNonce: request.compositionNonce,
          items: request.items.map((item) => ({
            marketId: item.marketId,
            kind:
              "predictionMarket" in item.kind
                ? {
                    predictionMarket: {
                      outcome: item.kind.predictionMarket.outcome,
                      ctfTokenId: [...item.kind.predictionMarket.ctfTokenId],
                    },
                  }
                : { spot: { tokenMint: item.kind.spot.tokenMint } },
            weightBps: item.weightBps,
          })),
        })
        .accountsStrict({
          config: this.config,
          compositionDraft,
          eligibilityList,
          composerSigner,
          systemProgram: SystemProgram.programId,
        });
      if (spotAllowlistAccounts.length > 0) {
        draftBuilder = draftBuilder.remainingAccounts(spotAllowlistAccounts);
      }
      await this.submitter.submit(Object.freeze({
        operationKey: `${operationKey}:composition-draft`,
        instructions: Object.freeze([await draftBuilder.instruction()]),
        requiredSignerPublicKeys: Object.freeze([composerSigner]),
      }));
    } else if (!existingDraft.owner.equals(this.program.programId)) {
      throw new Error("reconstitution composition-draft PDA has an unexpected owner");
    }
    let completionBuilder = this.program.methods.completeReconstitution({
      compositionHash: [...requireBytes(request.compositionHash, 32, "compositionHash")],
      eligibilityHash: [...suppliedEligibilityHash],
      eligibilityNonce: request.eligibilityNonce,
      compositionNonce: request.compositionNonce,
      compositionExpiry: request.compositionExpirySeconds,
    }).accountsStrict({
      config: this.config,
      basket: request.basket,
      compositionDraft,
      eligibilityList,
      backendSigner: this.options.backendSigner,
      composerSigner,
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    });
    if (spotAllowlistAccounts.length > 0) {
      completionBuilder = completionBuilder.remainingAccounts(spotAllowlistAccounts);
    }
    const instruction = await completionBuilder.instruction();
    return this.submitter.submit(Object.freeze({
      operationKey,
      instructions: Object.freeze([verify, instruction]),
      requiredSignerPublicKeys: Object.freeze([this.options.backendSigner, composerSigner]),
    }));
  }

  public async beginResolution(basket: PublicKey, operationKey: string): Promise<LifecycleTransactionResult> {
    const instruction = await this.program.methods.beginResolution().accountsStrict({
      config: this.config,
      basket,
      backendSigner: this.options.backendSigner,
    }).instruction();
    return this.submitter.submit(Object.freeze({
      operationKey,
      instructions: Object.freeze([instruction]),
      requiredSignerPublicKeys: Object.freeze([this.options.backendSigner]),
    }));
  }

  public async recordFinalSettlement(request: FinalSettlementRequest, operationKey: string): Promise<FinalSettlementResult> {
    requireBytes(request.finalReportHash, 32, "finalReportHash");
    if (request.finalNavValue < 0n) throw new RangeError("finalNavValue must be non-negative");
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.finalSettlementAttempts; attempt += 1) {
      try {
        // Settle exact elapsed fee dilution immediately before loading the final supply.
        await this.accrueManagementFee(request.basket, `${operationKey}:accrue:${attempt.toString(10)}`);
        const basket = await this.baskets.loadBasket(request.basket);
        const instruction = await this.program.methods.recordFinalSettlement({
          finalReportHash: [...request.finalReportHash],
          finalNavValue: request.finalNavValue,
          finalShareSnapshot: basket.totalSharesOutstanding,
        }).accountsStrict({
          config: this.config,
          basket: request.basket,
          backendSigner: this.options.backendSigner,
        }).instruction();
        const result = await this.submitter.submit(Object.freeze({
          operationKey: `${operationKey}:submit:${attempt.toString(10)}`,
          instructions: Object.freeze([instruction]),
          requiredSignerPublicKeys: Object.freeze([this.options.backendSigner]),
        }));
        return Object.freeze({ ...result, finalShareSnapshot: basket.totalSharesOutstanding });
      } catch (error) {
        lastError = error;
        if (!this.isFinalSnapshotRace(error)) throw error;
        if (attempt === this.finalSettlementAttempts) break;
      }
    }
    throw new Error("unable to record a stable final share snapshot", { cause: lastError });
  }
}
