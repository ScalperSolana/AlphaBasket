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
  deriveConfigPda,
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

    const [config] = deriveConfigPda(this.program.programId);
    const [basket] = deriveBasketPda(
      request.payload.basketId,
      this.program.programId,
    );
    const createInstruction = await this.program.methods
      .createBasket({
        basketId: [...request.payload.basketId],
        creator: request.payload.creator,
        creatorFeeDestination: request.payload.creatorFeeDestination,
        items: request.payload.composition.assets.map((asset) => ({
          marketId: asset.marketId,
          kind: {
            predictionMarket: {
              outcome: asset.kind.predictionMarket.outcome,
              ctfTokenId: [...asset.kind.predictionMarket.ctfTokenId],
            },
          },
          weightBps: asset.weightBps,
        })),
        compositionHash: [...request.payload.composition.hashBytes],
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
        composerSigner,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const verifyInstruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: request.composerPublicKey,
      message: request.encodedMessage,
      signature: request.composerSignature,
    });
    const transaction = new Transaction().add(
      verifyInstruction,
      createInstruction,
    );
    const sendAndConfirm = this.program.provider.sendAndConfirm;
    if (sendAndConfirm === undefined) {
      throw new TypeError("Anchor provider does not support transaction submission");
    }
    const transactionSignature = await sendAndConfirm.call(
      this.program.provider,
      transaction,
      [],
    );
    return Object.freeze({
      basketAddress: basket.toBase58(),
      transactionSignature,
    });
  }
}
