import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  BasketCompositionService,
  BasketCreationOrchestrator,
  ContractCompositionMessageEncoder,
  allocateCappedWeights,
  allocateEventCappedWeights,
  ctfTokenIdDecimalToBytes,
  type ComposerCandidate,
  type ComposerPolicy,
  type SolanaBasketCreationRequest,
} from "../src/composer/index.js";
import { compositionHash } from "../src/contract/index.js";

const NOW_MS = 2_000_000_000_000n;
const policy: ComposerPolicy = {
  minMarkets: 3,
  maxMarkets: 8,
  minRemainingMs: 86_400_000n,
  maxRemainingMs: 365n * 86_400_000n,
  maxSpreadBps: 500,
  minDepthPusdUnits: 1_000_000n,
  minVolume24hPusdUnits: 1_000_000n,
};

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

describe("deterministic Composer", () => {
  it("keeps every item positive, totals 10,000 bps and caps each event at 40%", () => {
    const composition = new BasketCompositionService().compose(
      [
        candidate(0, "event-a", 10n ** 18n),
        candidate(1, "event-b", 10n ** 12n),
        candidate(2, "event-c", 10n ** 6n),
        candidate(3, "event-d", 1n),
      ],
      policy,
      NOW_MS,
    );
    assert.equal(
      composition.items.reduce((sum, item) => sum + item.weightBps, 0),
      10_000,
    );
    assert.equal(composition.items.every((item) => item.weightBps > 0), true);
    const byEvent = new Map<string, number>();
    for (const item of composition.items) {
      assert.notEqual(item.eventId, null);
      byEvent.set(
        item.eventId ?? "",
        (byEvent.get(item.eventId ?? "") ?? 0) + item.weightBps,
      );
    }
    assert.equal([...byEvent.values()].every((weight) => weight <= 4_000), true);
    assert.equal(
      composition.hash,
      compositionHash(composition.assets).toString("hex"),
    );
  });

  it("does not emit zero weights for extreme score ratios", () => {
    const weights = allocateCappedWeights(
      [10n ** 30n, 10n ** 20n, 10n ** 10n, 1n].map((score, index) => ({
        key: `market-${index}`,
        score,
      })),
    );
    assert.equal(weights.every((row) => row.weightBps >= 1), true);
    assert.equal(weights.reduce((sum, row) => sum + row.weightBps, 0), 10_000);
  });

  it("reserves enough event budget for every market in a low-score event", () => {
    const allocations = allocateEventCappedWeights([
      ...Array.from({ length: 8 }, (_, index) => ({
        key: `low-${index}`,
        groupKey: "low-event",
        score: 1n,
      })),
      { key: "high-a", groupKey: "high-a", score: 10n ** 30n },
      { key: "high-b", groupKey: "high-b", score: 10n ** 29n },
      { key: "high-c", groupKey: "high-c", score: 10n ** 28n },
    ]);
    assert.equal(allocations.every((row) => row.weightBps > 0), true);
    assert.equal(allocations.reduce((sum, row) => sum + row.weightBps, 0), 10_000);
    assert.equal(
      allocations
        .filter((row) => row.key.startsWith("low-"))
        .reduce((sum, row) => sum + row.weightBps, 0) <= 4_000,
      true,
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
      compositionExpiry: 4_102_444_800n,
      candidates: [candidate(0), candidate(1), candidate(2)],
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
          [malformed, candidate(1), candidate(2)],
          policy,
          NOW_MS,
        ),
      /Invalid composer candidate/u,
    );
  });
});
