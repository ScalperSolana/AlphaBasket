import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  InMemoryLedgerRepository,
  LedgerIdempotencyConflictError,
  LedgerInsufficientBalanceError,
  LedgerService,
  LedgerValidationError,
  ledgerFingerprint,
} from "../src/ledger/index.js";

const NOW = new Date("2026-07-12T10:00:00.000Z");

describe("append-only double-entry ledger", () => {
  let repository: InMemoryLedgerRepository;
  let ledger: LedgerService;

  beforeEach(async () => {
    repository = new InMemoryLedgerRepository();
    ledger = new LedgerService(repository);
    await ledger.createAccount({
      id: "external",
      accountKey: "external:pusd",
      assetCode: "PUSD:POLYGON",
      kind: "unallocated",
      createdAt: NOW,
    });
    for (const [id, kind] of [
      ["available", "available"],
      ["reserved", "reserved"],
      ["inflight", "bridge_in_flight"],
    ] as const) {
      await ledger.createAccount({
        id,
        accountKey: `basket-a:${id}:pusd`,
        assetCode: "PUSD:POLYGON",
        kind,
        basketId: "basket-a",
        executionWalletId: "wallet-a",
        createdAt: NOW,
      });
    }
    await ledger.post({
      id: "seed-tx",
      idempotencyKey: "seed:basket-a",
      referenceType: "bridge_credit",
      referenceId: "deposit-1",
      occurredAt: NOW,
      entries: [
        { accountId: "external", side: "credit", amount: 1_000n },
        { accountId: "available", side: "debit", amount: 1_000n },
      ],
    });
  });

  it("moves integer base units through reserved and in-flight accounts", async () => {
    await ledger.reserve({
      id: "reserve-tx",
      idempotencyKey: "reserve:withdrawal-1",
      referenceType: "withdrawal_reservation",
      referenceId: "withdrawal-1",
      occurredAt: NOW,
      fromAccountId: "available",
      toAccountId: "reserved",
      amount: 600n,
    });
    await ledger.moveToBridgeInFlight({
      id: "bridge-tx",
      idempotencyKey: "bridge:withdrawal-1",
      referenceType: "withdrawal_bridge",
      referenceId: "withdrawal-1",
      occurredAt: NOW,
      fromAccountId: "reserved",
      toAccountId: "inflight",
      amount: 600n,
    });

    assert.deepEqual(await repository.getBalances(["available", "reserved", "inflight"]), [
      { accountId: "available", amount: 400n },
      { accountId: "reserved", amount: 0n },
      { accountId: "inflight", amount: 600n },
    ]);
  });

  it("returns the original transaction for an identical idempotent retry", async () => {
    const request = {
      id: "reserve-one",
      idempotencyKey: "reserve:same",
      referenceType: "withdrawal_reservation",
      referenceId: "withdrawal-same",
      occurredAt: NOW,
      fromAccountId: "available",
      toAccountId: "reserved",
      amount: 100n,
    } as const;
    const first = await ledger.reserve(request);
    const second = await ledger.reserve({
      ...request,
      id: "a-different-retry-id",
      occurredAt: new Date(NOW.getTime() + 1_000),
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.transaction.id, "reserve-one");
    assert.equal((await repository.getBalances(["available"]))[0]?.amount, 900n);
  });

  it("rejects idempotency-key reuse with different financial content", async () => {
    const base = {
      id: "reserve-conflict",
      idempotencyKey: "reserve:conflict",
      referenceType: "withdrawal_reservation",
      referenceId: "withdrawal-conflict",
      occurredAt: NOW,
      fromAccountId: "available",
      toAccountId: "reserved",
    } as const;
    await ledger.reserve({ ...base, amount: 100n });
    await assert.rejects(
      ledger.reserve({ ...base, amount: 101n }),
      LedgerIdempotencyConflictError,
    );
  });

  it("rejects unbalanced assets and zero or negative base-unit entries", async () => {
    await ledger.createAccount({
      id: "other-asset",
      accountKey: "external:usdc",
      assetCode: "USDC:SOLANA",
      kind: "unallocated",
      createdAt: NOW,
    });
    await assert.rejects(
      ledger.post({
        id: "cross-asset",
        idempotencyKey: "bad:cross-asset",
        referenceType: "bad",
        referenceId: "bad",
        occurredAt: NOW,
        entries: [
          { accountId: "external", side: "debit", amount: 1n },
          { accountId: "other-asset", side: "credit", amount: 1n },
        ],
      }),
      /unbalanced ledger transaction/,
    );
    await assert.rejects(
      ledger.post({
        id: "zero",
        idempotencyKey: "bad:zero",
        referenceType: "bad",
        referenceId: "bad",
        occurredAt: NOW,
        entries: [
          { accountId: "external", side: "debit", amount: 0n },
          { accountId: "external", side: "credit", amount: 0n },
        ],
      }),
      /positive base units/,
    );
  });

  it("prevents overdrafts, including two competing reservations", async () => {
    await assert.rejects(
      ledger.reserve({
        id: "too-large",
        idempotencyKey: "reserve:too-large",
        referenceType: "withdrawal_reservation",
        referenceId: "withdrawal-large",
        occurredAt: NOW,
        fromAccountId: "available",
        toAccountId: "reserved",
        amount: 1_001n,
      }),
      LedgerInsufficientBalanceError,
    );

    const attempts = await Promise.allSettled(
      ["one", "two"].map((suffix) =>
        ledger.reserve({
          id: `concurrent-${suffix}`,
          idempotencyKey: `reserve:concurrent:${suffix}`,
          referenceType: "withdrawal_reservation",
          referenceId: `withdrawal-${suffix}`,
          occurredAt: NOW,
          fromAccountId: "available",
          toAccountId: "reserved",
          amount: 700n,
        }),
      ),
    );
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await repository.getBalances(["available"]))[0]?.amount, 300n);
  });

  it("does not permit reservation moves across basket attribution", async () => {
    await ledger.createAccount({
      id: "other-reserved",
      accountKey: "basket-b:reserved:pusd",
      assetCode: "PUSD:POLYGON",
      kind: "reserved",
      basketId: "basket-b",
      executionWalletId: "wallet-a",
      createdAt: NOW,
    });
    await assert.rejects(
      ledger.reserve({
        id: "cross-basket",
        idempotencyKey: "reserve:cross-basket",
        referenceType: "withdrawal_reservation",
        referenceId: "withdrawal-cross-basket",
        occurredAt: NOW,
        fromAccountId: "available",
        toAccountId: "other-reserved",
        amount: 1n,
      }),
      LedgerValidationError,
    );
  });

  it("uses unambiguous fingerprints for adversarial identifiers and metadata", () => {
    const base = {
      id: "fingerprint",
      idempotencyKey: "fingerprint",
      occurredAt: NOW,
      entries: [
        { accountId: "external", side: "credit" as const, amount: 1n },
        { accountId: "available", side: "debit" as const, amount: 1n },
      ],
    };
    assert.notEqual(
      ledgerFingerprint({
        ...base,
        referenceType: "a\nb",
        referenceId: "c",
      }),
      ledgerFingerprint({
        ...base,
        referenceType: "a",
        referenceId: "b\nc",
      }),
    );
    assert.notEqual(
      ledgerFingerprint({
        ...base,
        referenceType: "metadata",
        referenceId: "one",
        metadata: { a: null, b: null },
      }),
      ledgerFingerprint({
        ...base,
        referenceType: "metadata",
        referenceId: "one",
        metadata: { "a=null&b": null },
      }),
    );
  });
});
