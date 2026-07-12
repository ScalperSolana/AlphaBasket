import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
  type Transaction,
} from "@solana/web3.js";

import type { PolybasketsEscrow } from "../src/contract/generated/polybaskets_escrow.js";
import {
  ALPHABASKET_PROGRAM_ID,
  compositionHash,
  type BasketAsset,
} from "../src/contract/index.js";
import { AnchorBasketCreationGateway } from "../src/runtime/index.js";

describe("Anchor basket-creation gateway", () => {
  it("places Ed25519 verification immediately before create_basket", async () => {
    const composer = new PublicKey(new Uint8Array(32).fill(7));
    const creator = new PublicKey(new Uint8Array(32).fill(8));
    const createProgram = new PublicKey(new Uint8Array(32).fill(9));
    let submitted: Transaction | undefined;
    let createArgs: unknown;
    const fakeProgram = {
      programId: ALPHABASKET_PROGRAM_ID,
      provider: {
        publicKey: composer,
        sendAndConfirm: async (transaction: Transaction) => {
          submitted = transaction;
          return "solana-signature";
        },
      },
      methods: {
        createBasket: (args: unknown) => {
          createArgs = args;
          return {
            accountsStrict: () => ({
              instruction: async () =>
                new TransactionInstruction({
                  programId: createProgram,
                  keys: [],
                  data: Buffer.from("create"),
                }),
            }),
          };
        },
      },
    } as unknown as Program<PolybasketsEscrow>;
    const assets: readonly BasketAsset[] = [
      {
        marketId: "1",
        kind: { predictionMarket: { outcome: 0, ctfTokenId: new Uint8Array(32).fill(1) } },
        weightBps: 4_000,
      },
      {
        marketId: "2",
        kind: { predictionMarket: { outcome: 1, ctfTokenId: new Uint8Array(32).fill(2) } },
        weightBps: 3_000,
      },
      {
        marketId: "3",
        kind: { predictionMarket: { outcome: 0, ctfTokenId: new Uint8Array(32).fill(3) } },
        weightBps: 3_000,
      },
    ];
    const hashBytes = compositionHash(assets);
    const result = await new AnchorBasketCreationGateway(fakeProgram).createBasket({
      payload: {
        basketId: new Uint8Array(32).fill(4),
        creator,
        creatorFeeDestination: creator,
        requestedPerformanceFeeBps: null,
        performanceFeeBps: 1_000,
        isPerpetual: true,
        reconstitutionCadenceSecs: 2_592_000n,
        compositionNonce: 1n,
        compositionExpiry: 4_102_444_800n,
        composition: {
          version: 1,
          hash: hashBytes.toString("hex"),
          hashBytes,
          auditHash: "aa".repeat(32),
          composedAtMs: 1n,
          items: [],
          assets,
          rejected: [],
        },
      },
      encodedMessage: Uint8Array.from([1, 2, 3]),
      composerPublicKey: composer.toBytes(),
      composerSignature: new Uint8Array(64).fill(5),
    });
    assert.equal(result.transactionSignature, "solana-signature");
    assert.equal(submitted?.instructions.length, 2);
    assert.equal(
      submitted?.instructions[0]?.programId.equals(Ed25519Program.programId),
      true,
    );
    assert.equal(submitted?.instructions[1]?.programId.equals(createProgram), true);
    assert.notEqual(createArgs, undefined);
  });
});
