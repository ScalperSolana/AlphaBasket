import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  BasketCompositionService,
  BasketCreationOrchestrator,
  ContractCompositionMessageEncoder,
  ctfTokenIdDecimalToBytes,
  type ComposerCandidate,
  type ComposerPolicy,
  type SolanaBasketCreationRequest,
} from "../src/composer/index.js";
import { compositionHash } from "../src/contract/index.js";

const NOW_MS = 2_000_000_000_000n;
const policy: ComposerPolicy = {
  minMarkets: 4,
  maxMarkets: 8,
  minRemainingMs: 86_400_000n,
  maxRemainingMs: 365n * 86_400_000n,
  maxSpreadBps: 500,
  minDepthPusdUnits: 1_000_000n,
  minVolume24hPusdUnits: 1_000_000n,
};

const creatorWeights = [0, 1, 2, 3].map((index) => ({
  marketId: String(1_000 + index),
  tokenId: String(10_000 + index),
  outcomeIndex: (index % 2 === 0 ? 0 : 1) as 0 | 1,
  weightBps: index < 2 ? 3_000 : 2_000,
}));

const candidate = (
  index: number,
  eventId = `event-${index}`,
  scoreUnits = BigInt(index + 1) * 10_000_000n,
): ComposerCandidate => ({
  marketId: String(1_000 + index),
  conditionId: `0x${index.toString(16).padStart(64, "0")}`,
  eventId,
  tokenId: String(10_000 + index),
  outcomeLabel: index % 2 === 0 ? "Yes" : "No",
  outcomeIndex: index % 2 === 0 ? 0 : 1,
  active: true,
  closed: false,
  acceptingOrders: true,
  endTimeMs: NOW_MS + 30n * 86_400_000n,
  thematicallyRelevant: true,
  outcomeClear: true,
  classificationSource: "theme-model:v1",
  hasBid: true,
  hasAsk: true,
  spreadBps: 100,
  midpointPriceUnits: 500_000n,
  depthPusdUnits: scoreUnits,
  volume24hPusdUnits: scoreUnits,
  dataCondition: "fresh",
});

describe("deterministic Composer eligibility and creator weights", () => {
  it("screens eligibility but preserves creator-assigned weights under the 30% cap", () => {
    const composition = new BasketCompositionService().compose(
      [
        candidate(0, "event-a", 10n ** 18n),
        candidate(1, "event-b", 10n ** 12n),
        candidate(2, "event-c", 10n ** 6n),
        candidate(3, "event-d", 1_000_000n),
      ],
      creatorWeights,
      policy,
      NOW_MS,
    );
    assert.equal(
      composition.items.reduce((sum, item) => sum + item.weightBps, 0),
      10_000,
    );
    assert.equal(composition.items.every((item) => item.weightBps > 0), true);
    assert.deepEqual(
      composition.items.map((item) => item.weightBps),
      [3_000, 3_000, 2_000, 2_000],
    );
    assert.equal(composition.eligibleMarkets.length, 4);
    assert.equal(
      composition.hash,
      compositionHash(composition.assets).toString("hex"),
    );
  });

  it("rejects overweight or ineligible creator selections", () => {
    const composer = new BasketCompositionService();
    const candidates = [candidate(0), candidate(1), candidate(2), candidate(3)];
    assert.throws(
      () =>
        composer.compose(
          candidates,
          creatorWeights.map((weight, index) => ({
            ...weight,
            weightBps: index === 0 ? 3_001 : index === 3 ? 1_999 : weight.weightBps,
          })),
          policy,
          NOW_MS,
        ),
      /1-3000/u,
    );
    assert.throws(
      () =>
        composer.compose(
          candidates,
          creatorWeights.map((weight, index) =>
            index === 0 ? { ...weight, marketId: "not-eligible" } : weight,
          ),
          policy,
          NOW_MS,
        ),
      /ineligible/u,
    );
  });

  it("converts decimal CTF token IDs to exact bytes32 big-endian", () => {
    assert.equal(
      Buffer.from(ctfTokenIdDecimalToBytes("258")).toString("hex"),
      `${"00".repeat(30)}0102`,
    );
    assert.throws(() => ctfTokenIdDecimalToBytes("01"), /canonical/u);
  });

  it("signs the exact create payload and preserves omitted fee versus explicit zero", async () => {
    let captured: SolanaBasketCreationRequest | undefined;
    const orchestrator = new BasketCreationOrchestrator(
      new BasketCompositionService(),
      new ContractCompositionMessageEncoder(),
      {
        sign: async () => ({
          publicKey: new Uint8Array(32).fill(7),
          signature: new Uint8Array(64).fill(8),
        }),
      },
      {
        createBasket: async (request) => {
          captured = request;
          return {
            basketAddress: "basket",
            transactionSignature: "signature",
            eligibilityTransactionSignature: null,
            compositionDraftTransactionSignature: null,
            compositionHash: request.payload.composition.hash,
            portfolioItems: [],
          };
        },
      },
      { nowMs: () => NOW_MS },
    );
    const creator = new PublicKey(new Uint8Array(32).fill(3));
    await orchestrator.composeSignAndCreate({
      basketId: new Uint8Array(32).fill(2),
      creator,
      creatorFeeDestination: creator,
      isPerpetual: true,
      reconstitutionCadenceSecs: 2_592_000n,
      compositionNonce: 1n,
      eligibilityNonce: 1n,
      compositionExpiry: 4_102_444_800n,
      candidates: [candidate(0), candidate(1), candidate(2), candidate(3)],
      creatorWeights,
      policy,
    });
    assert.equal(captured?.payload.requestedPerformanceFeeBps, null);
    assert.equal(captured?.payload.performanceFeeBps, 1_000);
    assert.equal((captured?.encodedMessage.length ?? 0) > 100, true);
  });

  it("rejects malformed classifier/metrics values at runtime", () => {
    const malformed = {
      ...candidate(0),
      active: "false",
    } as unknown as ComposerCandidate;
    assert.throws(
      () =>
        new BasketCompositionService().compose(
          [malformed, candidate(1), candidate(2), candidate(3)],
          creatorWeights,
          policy,
          NOW_MS,
        ),
      /Invalid composer candidate/u,
    );
  });
});
