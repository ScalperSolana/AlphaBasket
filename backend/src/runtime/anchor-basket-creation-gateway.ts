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
  deriveBasketPda,
  deriveCompositionDraftPda,
  deriveConfigPda,
  deriveEligibilityListPda,
  deriveTokenAllowlistPda,
} from "../contract/index.js";
import type { PolybasketsEscrow } from "../contract/generated/polybaskets_escrow.js";
import type {
  SolanaBasketCreationGatewayPort,
  SolanaBasketCreationRequest,
  SolanaBasketCreationResult,
} from "../composer/types.js";

/**
 * Sends the exact two-instruction create flow required by create_basket.rs:
 * Ed25519 verification immediately followed by create_basket.
 *
 * The injected Anchor provider wallet must be the configured Composer Service
 * authority because that account is both the transaction payer and signer.
 */
export class AnchorBasketCreationGateway
  implements SolanaBasketCreationGatewayPort
{
  public constructor(private readonly program: Program<PolybasketsEscrow>) {
    if (!program.programId.equals(ALPHABASKET_PROGRAM_ID)) {
      throw new TypeError("Anchor program ID does not match AlphaBasket");
    }
  }

  public async createBasket(
    request: SolanaBasketCreationRequest,
  ): Promise<SolanaBasketCreationResult> {
    if (
      request.composerPublicKey.byteLength !== 32 ||
      request.composerSignature.byteLength !== 64 ||
      request.encodedMessage.byteLength === 0
    ) {
      throw new TypeError("invalid Composer Ed25519 authorization envelope");
    }
    const composerSigner = new PublicKey(request.composerPublicKey);
    const providerKey = this.program.provider.publicKey;
    if (providerKey === undefined || !providerKey.equals(composerSigner)) {
      throw new TypeError(
        "Anchor provider wallet must match the Composer authorization key",
      );
    }
    const sendAndConfirm = this.program.provider.sendAndConfirm;
    if (sendAndConfirm === undefined) {
      throw new TypeError("Anchor provider does not support transaction submission");
    }

    const [config] = deriveConfigPda(this.program.programId);
    const [basket] = deriveBasketPda(
      request.payload.basketId,
      this.program.programId,
    );
    const [eligibilityList] = deriveEligibilityListPda(
      request.payload.composition.eligibilityHashBytes,
      request.payload.eligibilityNonce,
      this.program.programId,
    );
    const existingEligibility = await this.program.provider.connection.getAccountInfo(
      eligibilityList,
      "confirmed",
    );
    let eligibilityTransactionSignature: string | null = null;
    if (existingEligibility === null) {
      const publishInstruction = await this.program.methods
        .publishEligibilityList({
          listHash: [
            ...request.payload.composition.eligibilityHashBytes,
          ],
          nonce: request.payload.eligibilityNonce,
          expiresAt: request.payload.compositionExpiry,
          markets: request.payload.composition.eligibleMarkets.map((market) => ({
            marketId: market.marketId,
            outcome: market.outcome,
            ctfTokenId: [...market.ctfTokenId],
          })),
        })
        .accountsStrict({
          config,
          eligibilityList,
          composerSigner,
          systemProgram: SystemProgram.programId,
        })
        .instruction();
      eligibilityTransactionSignature = await sendAndConfirm.call(
        this.program.provider,
        new Transaction().add(publishInstruction),
        [],
      );
    } else if (!existingEligibility.owner.equals(this.program.programId)) {
      throw new Error("Eligibility PDA is owned by an unexpected program");
    }

    const [compositionDraft] = deriveCompositionDraftPda(
      request.payload.composition.hashBytes,
      request.payload.compositionNonce,
      this.program.programId,
    );
    const hasSpot = request.payload.composition.assets.some(
      (asset) => "spot" in asset.kind,
    );
    const spotAllowlistAccounts = hasSpot
      ? [{
          pubkey: deriveTokenAllowlistPda(this.program.programId)[0],
          isSigner: false,
          isWritable: false,
        }]
      : [];
    const existingDraft = await this.program.provider.connection.getAccountInfo(
      compositionDraft,
      "confirmed",
    );
    let compositionDraftTransactionSignature: string | null = null;
    if (existingDraft === null) {
      let draftBuilder = this.program.methods
        .publishCompositionDraft({
          compositionHash: [...request.payload.composition.hashBytes],
          eligibilityHash: [
            ...request.payload.composition.eligibilityHashBytes,
          ],
          eligibilityNonce: request.payload.eligibilityNonce,
          compositionNonce: request.payload.compositionNonce,
          items: request.payload.composition.assets.map((asset) => ({
            marketId: asset.marketId,
            kind:
              "predictionMarket" in asset.kind
                ? {
                    predictionMarket: {
                      outcome: asset.kind.predictionMarket.outcome,
                      ctfTokenId: [...asset.kind.predictionMarket.ctfTokenId],
                    },
                  }
                : { spot: { tokenMint: asset.kind.spot.tokenMint } },
            weightBps: asset.weightBps,
          })),
        })
        .accountsStrict({
          config,
          compositionDraft,
          eligibilityList,
          composerSigner,
          systemProgram: SystemProgram.programId,
        });
      if (spotAllowlistAccounts.length > 0) {
        draftBuilder = draftBuilder.remainingAccounts(spotAllowlistAccounts);
      }
      compositionDraftTransactionSignature = await sendAndConfirm.call(
        this.program.provider,
        new Transaction().add(await draftBuilder.instruction()),
        [],
      );
    } else if (!existingDraft.owner.equals(this.program.programId)) {
      throw new Error("Composition-draft PDA is owned by an unexpected program");
    }

    let createBuilder = this.program.methods
      .createBasket({
        basketId: [...request.payload.basketId],
        creator: request.payload.creator,
        creatorFeeDestination: request.payload.creatorFeeDestination,
        compositionHash: [...request.payload.composition.hashBytes],
        eligibilityHash: [
          ...request.payload.composition.eligibilityHashBytes,
        ],
        eligibilityNonce: request.payload.eligibilityNonce,
        performanceFeeBps: request.payload.requestedPerformanceFeeBps,
        isPerpetual: request.payload.isPerpetual,
        reconstitutionCadenceSecs:
          request.payload.reconstitutionCadenceSecs,
        compositionNonce: request.payload.compositionNonce,
        compositionExpiry: request.payload.compositionExpiry,
      })
      .accountsStrict({
        config,
        basket,
        compositionDraft,
        eligibilityList,
        composerSigner,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      });
    if (spotAllowlistAccounts.length > 0) {
      createBuilder = createBuilder.remainingAccounts(spotAllowlistAccounts);
    }
    const createInstruction = await createBuilder.instruction();

    const verifyInstruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: request.composerPublicKey,
      message: request.encodedMessage,
      signature: request.composerSignature,
    });
    const transaction = new Transaction().add(
      verifyInstruction,
      createInstruction,
    );
    const transactionSignature = await sendAndConfirm.call(
      this.program.provider,
      transaction,
      [],
    );
    return Object.freeze({
      basketAddress: basket.toBase58(),
      transactionSignature,
      eligibilityTransactionSignature,
      compositionDraftTransactionSignature,
      compositionHash: request.payload.composition.hash,
      portfolioItems: Object.freeze(
        request.payload.composition.items.map((item) =>
          Object.freeze({
            marketId: item.marketId,
            conditionId: item.conditionId,
            tokenId: item.tokenId,
            outcome: item.outcomeLabel,
            initialMarkPriceUnits: item.initialMarkPriceUnits,
            markObservedAtMs: request.payload.composition.composedAtMs,
            markSourceHash: `composer:${request.payload.composition.auditHash}:${item.tokenId}`,
          }),
        ),
      ),
    });
  }
}
