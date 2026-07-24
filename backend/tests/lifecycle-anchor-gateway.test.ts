import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Program } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";

import type { PolybasketsEscrow } from "../src/contract/generated/polybaskets_escrow.js";
import {
  ALPHABASKET_PROGRAM_ID,
  compositionHash,
  reconstitutionAuthorizationMessage,
  type BasketAsset,
} from "../src/contract/index.js";
import {
  AnchorLifecycleGateway,
  type LifecycleBasket,
  type LifecycleInstructionBatch,
} from "../src/lifecycle/index.js";

const backendSigner = new PublicKey(new Uint8Array(32).fill(21));
const composerSigner = new PublicKey(new Uint8Array(32).fill(22));
const basketAddress = new PublicKey(new Uint8Array(32).fill(23));
const lifecycleProgram = new PublicKey(new Uint8Array(32).fill(24));

const assets: readonly BasketAsset[] = Object.freeze([
  { marketId: "market-a", kind: { predictionMarket: { outcome: 1, ctfTokenId: new Uint8Array(32).fill(1) } }, weightBps: 4_000 },
  { marketId: "market-b", kind: { predictionMarket: { outcome: 0, ctfTokenId: new Uint8Array(32).fill(2) } }, weightBps: 3_000 },
  { marketId: "market-c", kind: { predictionMarket: { outcome: 1, ctfTokenId: new Uint8Array(32).fill(3) } }, weightBps: 3_000 },
]);

function basket(totalSharesOutstanding = 100n): LifecycleBasket {
  return Object.freeze({
    address: basketAddress,
    basketId: new Uint8Array(32).fill(7),
    status: "reconstituting",
    isPerpetual: true,
    compositionVersion: 1,
    lastCompositionNonce: 4n,
    lastManagementFeeAtSeconds: 1n,
    lastReconstitutionAtSeconds: 1n,
    reconstitutionCadenceSeconds: 2_592_000n,
    totalSharesOutstanding,
  });
}

function fakeProgram(): Program<PolybasketsEscrow> {
  const instruction = (name: string) => new TransactionInstruction({
    programId: lifecycleProgram,
    keys: [],
    data: Buffer.from(name, "utf8"),
  });
  const builder = (name: string) => ({
    accountsStrict: () => ({ instruction: async () => instruction(name) }),
  });
  return {
    programId: ALPHABASKET_PROGRAM_ID,
    methods: {
      accrueManagementFee: () => builder("accrue"),
      beginReconstitution: () => builder("begin-reconstitution"),
      completeReconstitution: () => builder("complete-reconstitution"),
      beginResolution: () => builder("begin-resolution"),
      recordFinalSettlement: () => builder("final-settlement"),
    },
  } as unknown as Program<PolybasketsEscrow>;
}

function signedReconstitution() {
  const current = basket();
  const hash = compositionHash(assets);
  const message = reconstitutionAuthorizationMessage({
    basketId: current.basketId,
    nextCompositionVersion: 2,
    compositionHash: hash,
    compositionNonce: 5n,
    compositionExpiry: 4_102_444_800n,
  });
  return Object.freeze({
    basket: basketAddress,
    basketId: current.basketId,
    nextCompositionVersion: 2,
    compositionHash: Uint8Array.from(hash),
    items: assets,
    compositionNonce: 5n,
    compositionExpirySeconds: 4_102_444_800n,
    encodedMessage: Uint8Array.from(message),
    composerPublicKey: composerSigner.toBytes(),
    composerSignature: new Uint8Array(64).fill(9),
  });
}

describe("Anchor lifecycle transaction boundary", () => {
  it("re-derives the signed composition and keeps Ed25519 immediately before completion", async () => {
    const batches: LifecycleInstructionBatch[] = [];
    const gateway = new AnchorLifecycleGateway(
      fakeProgram(),
      { submit: async (batch) => {
        batches.push(batch);
        return { transactionSignature: "complete-tx", finalizedSlot: 8n };
      } },
      { listBaskets: async () => [], loadBasket: async () => basket() },
      { backendSigner, composerSigner },
    );
    await gateway.completeReconstitution(signedReconstitution(), "reconstitution:complete");
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.instructions.length, 2);
    assert.equal(batches[0]?.instructions[0]?.programId.equals(Ed25519Program.programId), true);
    assert.equal(batches[0]?.instructions[1]?.programId.equals(lifecycleProgram), true);
    assert.deepEqual(batches[0]?.requiredSignerPublicKeys.map((key) => key.toBase58()), [
      backendSigner.toBase58(),
      composerSigner.toBase58(),
    ]);

    const valid = signedReconstitution();
    const tampered = { ...valid, encodedMessage: Uint8Array.from(valid.encodedMessage) };
    const lastIndex = tampered.encodedMessage.length - 1;
    tampered.encodedMessage[lastIndex] = (tampered.encodedMessage[lastIndex] ?? 0) ^ 1;
    await assert.rejects(gateway.completeReconstitution(tampered, "tampered"), /not canonical/u);
    assert.equal(batches.length, 1);
  });

  it("does not retry final settlement for unrelated signer/provider failures", async () => {
    let finalSubmissions = 0;
    const gateway = new AnchorLifecycleGateway(
      fakeProgram(),
      { submit: async (batch) => {
        if (batch.operationKey.includes(":accrue:")) return { transactionSignature: "accrue", finalizedSlot: 1n };
        finalSubmissions += 1;
        throw new Error("KMS signer unavailable");
      } },
      { listBaskets: async () => [], loadBasket: async () => basket() },
      { backendSigner, composerSigner, finalSettlementAttempts: 3 },
    );
    await assert.rejects(gateway.recordFinalSettlement({
      basket: basketAddress,
      finalReportHash: new Uint8Array(32).fill(5),
      finalNavValue: 100n,
    }, "resolution:final"), /KMS signer unavailable/u);
    assert.equal(finalSubmissions, 1);
  });

  it("retries only a final-share-snapshot race with a fresh operation key", async () => {
    const finalKeys: string[] = [];
    let reads = 0;
    const gateway = new AnchorLifecycleGateway(
      fakeProgram(),
      { submit: async (batch) => {
        if (batch.operationKey.includes(":accrue:")) return { transactionSignature: "accrue", finalizedSlot: 1n };
        finalKeys.push(batch.operationKey);
        if (finalKeys.length === 1) throw new Error("FinalSnapshotMismatch");
        return { transactionSignature: "final", finalizedSlot: 9n };
      } },
      { listBaskets: async () => [], loadBasket: async () => basket(100n + BigInt(reads++)) },
      { backendSigner, composerSigner, finalSettlementAttempts: 3 },
    );
    const result = await gateway.recordFinalSettlement({
      basket: basketAddress,
      finalReportHash: new Uint8Array(32).fill(5),
      finalNavValue: 101n,
    }, "resolution:final");
    assert.equal(result.finalShareSnapshot, 101n);
    assert.deepEqual(finalKeys, ["resolution:final:submit:1", "resolution:final:submit:2"]);
  });
});
