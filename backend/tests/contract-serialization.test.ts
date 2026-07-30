import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PublicKey } from "@solana/web3.js";

import {
  ALPHABASKET_PROGRAM_ID,
  canonicalCompositionBytes,
  canonicalEligibilityBytes,
  compositionHash,
  createCompositionAuthorizationMessage,
  depositIntentHash,
  depositIntentMessage,
  deriveBasketPda,
  deriveConfigPda,
  derivePositionPda,
  deriveReceiptPda,
  encodeI64LE,
  encodeU64LE,
  eligibilityHash,
  receiptExecutionHash,
  reconstitutionAuthorizationMessage,
  sha256,
  withdrawalIntentHash,
  withdrawalIntentMessage,
  type BasketAsset,
} from "../src/contract/index.js";

const bytes = (value: number): Buffer => Buffer.alloc(32, value);
const basketId = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const creator = new PublicKey(bytes(0x11));
const creatorFeeDestination = new PublicKey(bytes(0x22));
const user = new PublicKey(bytes(0x33));
const quoteHash = bytes(0x44);
const executionBatchHash = bytes(0x55);

const items: readonly BasketAsset[] = [
  {
    marketId: "market-a",
    kind: { predictionMarket: { outcome: 1, ctfTokenId: bytes(1) } },
    weightBps: 3_000,
  },
  {
    marketId: "market-b",
    kind: { predictionMarket: { outcome: 0, ctfTokenId: bytes(2) } },
    weightBps: 3_000,
  },
  {
    marketId: "market-c",
    kind: { predictionMarket: { outcome: 1, ctfTokenId: bytes(3) } },
    weightBps: 2_000,
  },
  {
    marketId: "market-d",
    kind: { predictionMarket: { outcome: 0, ctfTokenId: bytes(4) } },
    weightBps: 2_000,
  },
];
const eligibleMarkets = items.map((item) => {
  if (!("predictionMarket" in item.kind)) throw new Error("test fixture must be prediction");
  return {
    marketId: item.marketId,
    outcome: item.kind.predictionMarket.outcome,
    ctfTokenId: item.kind.predictionMarket.ctfTokenId,
  };
});

// These vectors use the exact field order and little-endian writes in the
// program's Rust `canonical_composition_bytes` and message builders.
const CANONICAL_COMPOSITION_HEX =
  "040008006d61726b65742d6100010101010101010101010101010101010101010101010101010101010101010101b80b08006d61726b65742d6200000202020202020202020202020202020202020202020202020202020202020202b80b08006d61726b65742d6300010303030303030303030303030303030303030303030303030303030303030303d00708006d61726b65742d6400000404040404040404040404040404040404040404040404040404040404040404d007";
const COMPOSITION_HASH_HEX =
  "a53b67dfa5a9a32e6665e532bbb5734e1109d11f48d64c0e3c65718e2ebf4a50";
const CANONICAL_ELIGIBILITY_HEX =
  "040008006d61726b65742d6101010101010101010101010101010101010101010101010101010101010101010108006d61726b65742d6200020202020202020202020202020202020202020202020202020202020202020208006d61726b65742d6301030303030303030303030303030303030303030303030303030303030303030308006d61726b65742d64000404040404040404040404040404040404040404040404040404040404040404";
const ELIGIBILITY_HASH_HEX =
  "f2025565617356e136e66c211b810922af32cea88a9e7d111a8543882d94eddf";
const CREATE_MESSAGE_HEX =
  "41425f4352454154455f563246f523ab30393190549ed6672104cb14dc8c38d69ef19d6323e05e919dac7486000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222f2025565617356e136e66c211b810922af32cea88a9e7d111a8543882d94eddf0800000000000000e80301008d2700000000000900000000000000005786f400000000";
const RECONSTITUTION_MESSAGE_HEX =
  "41425f5245434f4e5f563246f523ab30393190549ed6672104cb14dc8c38d69ef19d6323e05e919dac7486000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f04000000f2025565617356e136e66c211b810922af32cea88a9e7d111a8543882d94eddf08000000000000000a00000000000000c894357700000000";

describe("contract composition serialization", () => {
  it("matches the Rust canonical composition and SHA-256 golden vector", () => {
    assert.equal(
      canonicalCompositionBytes(items).toString("hex"),
      CANONICAL_COMPOSITION_HEX,
    );
    assert.equal(compositionHash(items).toString("hex"), COMPOSITION_HASH_HEX);
    assert.equal(
      canonicalEligibilityBytes(eligibleMarkets).toString("hex"),
      CANONICAL_ELIGIBILITY_HEX,
    );
    assert.equal(
      eligibilityHash(eligibleMarkets).toString("hex"),
      ELIGIBILITY_HASH_HEX,
    );
  });

  it("matches the Rust create and reconstitution authorization preimages", () => {
    const hash = eligibilityHash(eligibleMarkets);
    const createMessage = createCompositionAuthorizationMessage({
      basketId,
      creator,
      creatorFeeDestination,
      eligibilityHash: hash,
      eligibilityNonce: 8n,
      performanceFeeBps: 1_000,
      isPerpetual: true,
      reconstitutionCadenceSecs: 2_592_000n,
      compositionNonce: 9n,
      compositionExpiry: 4_102_444_800n,
    });
    assert.equal(createMessage.toString("hex"), CREATE_MESSAGE_HEX);
    assert.equal(
      sha256(createMessage).toString("hex"),
      "71ab064e818b5daadb3c73f45cd2508c668c77fad40e2025f914f35d97e202a0",
    );

    const reconstitution = reconstitutionAuthorizationMessage({
      basketId,
      nextCompositionVersion: 4,
      eligibilityHash: hash,
      eligibilityNonce: 8n,
      compositionNonce: 10n,
      compositionExpiry: 2_000_000_200n,
    });
    assert.equal(reconstitution.toString("hex"), RECONSTITUTION_MESSAGE_HEX);
    assert.equal(
      sha256(reconstitution).toString("hex"),
      "396c9d86762f1ec904e64a8489c2687684032993ffd7ca0129d2157d60275a0d",
    );
  });

  it("enforces the same composition constraints before signing", () => {
    assert.throws(
      () =>
        canonicalCompositionBytes([
          { ...items[0]!, weightBps: 3_001 },
          items[1]!,
          items[2]!,
          { ...items[3]!, weightBps: 1_999 },
        ]),
      /weightBps/,
    );
    assert.throws(
      () => canonicalCompositionBytes([items[0]!, items[0]!, items[2]!]),
      /duplicate/,
    );
    assert.throws(
      () =>
        canonicalCompositionBytes([
          {
            ...items[0]!,
            kind: {
              predictionMarket: { outcome: 2, ctfTokenId: bytes(9) },
            },
          },
          items[1]!,
          items[2]!,
        ]),
      /outcome/,
    );
  });
});

describe("contract intent serialization", () => {
  const basket = deriveBasketPda(basketId)[0];

  it("matches the Rust deposit intent preimage and hash", () => {
    const intent = {
      basket,
      user,
      intentNonce: 7n,
      intentExpiry: 2_000_000_000n,
      expectedCompositionVersion: 3,
      grossAmount: 123_456_789n,
      minSharesOut: 120_000_000n,
      quoteHash,
    };
    assert.equal(
      depositIntentMessage(intent).toString("hex"),
      "414c5048414241534b45545f4445504f5349545f494e54454e545f563146f523ab30393190549ed6672104cb14dc8c38d69ef19d6323e05e919dac7486330c092e5a6bbf33582274ecbb1f81816934f09003bf5e5e2c9d43c034901f343333333333333333333333333333333333333333333333333333333333333333070000000000000000943577000000000300000015cd5b0700000000000e2707000000004444444444444444444444444444444444444444444444444444444444444444",
    );
    assert.equal(
      depositIntentHash(intent).toString("hex"),
      "434ba44b234f7f724e6ec7a3b73808931cb12801b7ee71ded17e67cf2b67cca8",
    );
  });

  it("matches the Rust withdrawal intent preimage and hash", () => {
    const intent = {
      basket,
      user,
      intentNonce: 8n,
      intentExpiry: 2_000_000_100n,
      expectedCompositionVersion: 3,
      shareAmount: 50_000_000n,
      minValueOut: 47_000_000n,
      destination: creatorFeeDestination,
      quoteHash,
    };
    assert.equal(
      withdrawalIntentMessage(intent).toString("hex"),
      "414c5048414241534b45545f5749544844524157414c5f494e54454e545f563146f523ab30393190549ed6672104cb14dc8c38d69ef19d6323e05e919dac7486330c092e5a6bbf33582274ecbb1f81816934f09003bf5e5e2c9d43c034901f343333333333333333333333333333333333333333333333333333333333333333080000000000000064943577000000000300000080f0fa0200000000c029cd020000000022222222222222222222222222222222222222222222222222222222222222224444444444444444444444444444444444444444444444444444444444444444",
    );
    assert.equal(
      withdrawalIntentHash(intent).toString("hex"),
      "e13bd7d71af4fba639c2b4b2a5029d10f2f58263a937029f167aae6740441217",
    );
  });
});

describe("contract PDA and primitive validation", () => {
  it("matches fixed PDA golden vectors", () => {
    const [config, configBump] = deriveConfigPda();
    const [basket, basketBump] = deriveBasketPda(basketId);
    const [position, positionBump] = derivePositionPda(basket, user);
    const [receipt, receiptBump] = deriveReceiptPda(executionBatchHash);

    assert.equal(ALPHABASKET_PROGRAM_ID.toBase58(), "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm");
    assert.deepEqual(
      [config.toBase58(), configBump],
      ["GEnKDYuWthH6P6Hzm2gmBEhMMfHGg4wgwPzcFNketWAY", 255],
    );
    assert.deepEqual(
      [basket.toBase58(), basketBump],
      ["4SGSMd3xAgpdbfpAs4iSsMiqe1niGiBy4ciE3hQvSYnF", 255],
    );
    assert.deepEqual(
      [position.toBase58(), positionBump],
      ["3gUGUKXR5BjZXjJwi6aeYaaArVm3TZk8ydNRHVg47Z8x", 254],
    );
    assert.deepEqual(
      [receipt.toBase58(), receiptBump],
      ["GPq98o2jr5sEGPxR5i6RgoN5fq9xVYHKAhtv57PGUzyt", 255],
    );
  });

  it("rejects wrong-sized, zero and non-bigint values", () => {
    assert.throws(() => deriveBasketPda(Buffer.alloc(31)), /32 bytes/);
    assert.throws(() => deriveReceiptPda(Buffer.alloc(32)), /all zeroes/);
    assert.throws(() => receiptExecutionHash(Buffer.alloc(32)), /all zeroes/);
    assert.throws(
      () => encodeU64LE(1 as unknown as bigint),
      /u64 bigint/,
    );
    assert.throws(() => encodeU64LE(1n << 64n), /u64 bigint/);
    assert.throws(() => encodeI64LE(1n << 63n), /i64 bigint/);
    assert.equal(encodeU64LE(0x0102n).toString("hex"), "0201000000000000");
    assert.equal(
      encodeI64LE(-2n).toString("hex"),
      "feffffffffffffff",
    );
  });
});
