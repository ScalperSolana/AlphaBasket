import {
  reconstitutionAuthorizationMessage,
} from "../contract/messages.js";
import { BasketCompositionService } from "../composer/composition-service.js";
import type {
  ComposerCandidate,
  ComposerPolicy,
  ComposerSignerPort,
  CreatorMarketWeight,
} from "../composer/types.js";
import type { LifecycleBasket, SignedReconstitution } from "./types.js";

export interface ReconstitutionPlanRequest {
  readonly basket: LifecycleBasket;
  readonly candidates: readonly ComposerCandidate[];
  readonly policy: ComposerPolicy;
  readonly creatorWeights: readonly CreatorMarketWeight[];
  readonly eligibilityNonce: bigint;
  readonly compositionNonce: bigint;
  readonly compositionExpirySeconds: bigint;
  readonly nowMs: bigint;
}

export class ReconstitutionPlanner {
  public constructor(
    private readonly composer: BasketCompositionService,
    private readonly signer: ComposerSignerPort,
  ) {}

  public async plan(request: ReconstitutionPlanRequest): Promise<SignedReconstitution> {
    if (!request.basket.isPerpetual || request.basket.status !== "active") throw new Error("only active perpetual baskets can be reconstituted");
    if (request.compositionNonce <= request.basket.lastCompositionNonce) throw new Error("composition nonce must increase");
    if (request.eligibilityNonce <= 0n) throw new Error("eligibility nonce must be positive");
    if (request.compositionExpirySeconds <= request.nowMs / 1_000n) throw new Error("composition authorization is already expired");
    const composition = this.composer.compose(
      request.candidates,
      request.creatorWeights,
      request.policy,
      request.nowMs,
    );
    const nextCompositionVersion = request.basket.compositionVersion + 1;
    const encodedMessage = reconstitutionAuthorizationMessage({
      basketId: request.basket.basketId,
      nextCompositionVersion,
      eligibilityHash: composition.eligibilityHashBytes,
      eligibilityNonce: request.eligibilityNonce,
      compositionNonce: request.compositionNonce,
      compositionExpiry: request.compositionExpirySeconds,
    });
    const signed = await this.signer.sign(encodedMessage);
    if (signed.publicKey.byteLength !== 32 || signed.signature.byteLength !== 64) throw new Error("composer signer returned an invalid Ed25519 signature");
    return Object.freeze({
      basket: request.basket.address,
      basketId: Uint8Array.from(request.basket.basketId),
      nextCompositionVersion,
      compositionHash: Uint8Array.from(composition.hashBytes),
      eligibilityHash: Uint8Array.from(composition.eligibilityHashBytes),
      eligibilityNonce: request.eligibilityNonce,
      eligibleMarkets: composition.eligibleMarkets,
      items: composition.assets,
      compositionNonce: request.compositionNonce,
      compositionExpirySeconds: request.compositionExpirySeconds,
      encodedMessage: Uint8Array.from(encodedMessage),
      composerPublicKey: Uint8Array.from(signed.publicKey),
      composerSignature: Uint8Array.from(signed.signature),
    });
  }
}
