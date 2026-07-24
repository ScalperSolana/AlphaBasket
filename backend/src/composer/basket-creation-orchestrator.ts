import { PublicKey } from "@solana/web3.js";
import { DEFAULT_CREATOR_PERFORMANCE_FEE_BPS, MAX_CREATOR_PERFORMANCE_FEE_BPS } from "../contract/constants.js";
import { createCompositionAuthorizationMessage } from "../contract/messages.js";
import { BasketCompositionService } from "./composition-service.js";
import type {
  ComposerCandidate,
  ComposerClockPort,
  ComposerPolicy,
  ComposerSignerPort,
  CompositionMessageEncoderPort,
  CompositionSigningPayload,
  SolanaBasketCreationGatewayPort,
  SolanaBasketCreationResult,
} from "./types.js";

export interface ComposeAndCreateBasketCommand {
  readonly basketId: Uint8Array;
  readonly creator: PublicKey;
  readonly creatorFeeDestination: PublicKey;
  readonly isPerpetual: boolean;
  readonly reconstitutionCadenceSecs: bigint;
  readonly compositionNonce: bigint;
  readonly compositionExpiry: bigint;
  readonly performanceFeeBps?: number;
  readonly candidates: readonly ComposerCandidate[];
  readonly policy: ComposerPolicy;
}

/** Exact adapter for the byte layout verified by create_basket.rs. */
export class ContractCompositionMessageEncoder implements CompositionMessageEncoderPort {
  public encode(payload: CompositionSigningPayload): Uint8Array {
    return Uint8Array.from(
      createCompositionAuthorizationMessage({
        basketId: payload.basketId,
        creator: payload.creator,
        creatorFeeDestination: payload.creatorFeeDestination,
        compositionHash: payload.composition.hashBytes,
        performanceFeeBps: payload.performanceFeeBps,
        isPerpetual: payload.isPerpetual,
        reconstitutionCadenceSecs: payload.reconstitutionCadenceSecs,
        compositionNonce: payload.compositionNonce,
        compositionExpiry: payload.compositionExpiry,
      }),
    );
  }
}

export class BasketCreationOrchestrator {
  public constructor(
    private readonly composer: BasketCompositionService,
    private readonly encoder: CompositionMessageEncoderPort,
    private readonly signer: ComposerSignerPort,
    private readonly gateway: SolanaBasketCreationGatewayPort,
    private readonly clock: ComposerClockPort,
  ) {}

  public async composeSignAndCreate(
    command: ComposeAndCreateBasketCommand,
  ): Promise<SolanaBasketCreationResult> {
    if (command.basketId.length !== 32) {
      throw new TypeError("basketId must be exactly 32 bytes");
    }
    const performanceFeeBps = command.performanceFeeBps ?? DEFAULT_CREATOR_PERFORMANCE_FEE_BPS;
    if (
      !Number.isSafeInteger(performanceFeeBps) ||
      performanceFeeBps < 0 ||
      performanceFeeBps > MAX_CREATOR_PERFORMANCE_FEE_BPS
    ) {
      throw new RangeError("performanceFeeBps must be an integer between 0 and 2000");
    }
    const composition = this.composer.compose(command.candidates, command.policy, this.clock.nowMs());
    const payload: CompositionSigningPayload = Object.freeze({
      basketId: Uint8Array.from(command.basketId),
      creator: command.creator,
      creatorFeeDestination: command.creatorFeeDestination,
      requestedPerformanceFeeBps: command.performanceFeeBps ?? null,
      performanceFeeBps,
      isPerpetual: command.isPerpetual,
      reconstitutionCadenceSecs: command.reconstitutionCadenceSecs,
      compositionNonce: command.compositionNonce,
      compositionExpiry: command.compositionExpiry,
      composition,
    });
    const encodedMessage = Uint8Array.from(this.encoder.encode(payload));
    const signed = await this.signer.sign(encodedMessage);
    const composerPublicKey = signed.publicKey;
    const composerSignature = signed.signature;
    if (composerPublicKey.length !== 32 || composerSignature.length !== 64) {
      throw new Error("Composer signer must return a 32-byte Ed25519 key and 64-byte signature");
    }
    return this.gateway.createBasket(
      Object.freeze({
        payload,
        encodedMessage: Uint8Array.from(encodedMessage),
        composerPublicKey: Uint8Array.from(composerPublicKey),
        composerSignature: Uint8Array.from(composerSignature),
      }),
    );
  }
}
