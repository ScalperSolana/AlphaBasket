import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CursorConflictError,
  EventCursorGapError,
  SolanaAccountIndexer,
  SolanaEventIndexer,
  type EventCursor,
  type IndexedAccountRecord,
  type IndexedEventRecord,
  type ProgramAccountSnapshot,
  type SolanaReadRpcPort,
} from "../src/indexer/index.js";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("Solana read-plane indexers", () => {
  it("cannot roll account projections back under concurrent snapshots", async () => {
    const oldSnapshot = deferred<ProgramAccountSnapshot>();
    let calls = 0;
    const rpc: SolanaReadRpcPort = {
      getProgramAccounts: async () => {
        calls += 1;
        if (calls === 1) return oldSnapshot.promise;
        return {
          contextSlot: 20n,
          accounts: [
            {
              address: "account-a",
              owner: "program-a",
              lamports: 20n,
              data: Uint8Array.of(20),
            },
          ],
        };
      },
      getSignaturesForAddress: async () => [],
      getTransaction: async () => null,
    };
    const projected = new Map<string, IndexedAccountRecord>();
    const sink = {
      applySnapshotMonotonic: async (
        _programId: string,
        _sourceSlot: bigint,
        records: readonly IndexedAccountRecord[],
      ) => {
        for (const record of records) {
          const current = projected.get(record.address);
          if (current === undefined || current.sourceSlot <= record.sourceSlot) {
            projected.set(record.address, record);
          }
        }
      },
    };
    let cursor: bigint | null = null;
    const cursors = {
      load: async () => cursor,
      compareAndSet: async (_stream: string, expected: bigint | null, next: bigint) => {
        if (cursor !== expected) return false;
        cursor = next;
        return true;
      },
    };
    const indexer = new SolanaAccountIndexer(
      rpc,
      {
        decodeAccount: (account) => ({ kind: "basket", data: { byte: account.data[0] } }),
        decodeEvents: () => [],
      },
      sink,
      cursors,
      { programId: "program-a", stream: "accounts" },
    );
    const older = indexer.sync();
    const newer = indexer.sync();
    await newer;
    oldSnapshot.resolve({
      contextSlot: 10n,
      accounts: [
        {
          address: "account-a",
          owner: "program-a",
          lamports: 10n,
          data: Uint8Array.of(10),
        },
      ],
    });
    await assert.rejects(older, CursorConflictError);
    assert.equal(projected.get("account-a")?.sourceSlot, 20n);
    assert.equal(projected.get("account-a")?.lamports, 20n);
  });

  it("backfills every page oldest-first and advances to the newest signature", async () => {
    const signatures = [
      { signature: "s3", slot: 3n, failed: false, blockTimeMs: 3_000n },
      { signature: "s2", slot: 2n, failed: false, blockTimeMs: 2_000n },
      { signature: "s1", slot: 1n, failed: false, blockTimeMs: 1_000n },
    ];
    const rpc: SolanaReadRpcPort = {
      getProgramAccounts: async () => ({ contextSlot: 0n, accounts: [] }),
      getSignaturesForAddress: async (_address, options) =>
        options.before === null ? signatures.slice(0, 2) : signatures.slice(2),
      getTransaction: async (signature) => {
        const info = signatures.find((row) => row.signature === signature);
        return info === undefined
          ? null
          : {
              signature,
              slot: info.slot,
              blockTimeMs: info.blockTimeMs,
              payload: { signature },
            };
      },
    };
    const events: IndexedEventRecord[] = [];
    let cursor: EventCursor | null = null;
    const indexer = new SolanaEventIndexer(
      rpc,
      {
        decodeAccount: () => null,
        decodeEvents: (transaction) => [
          { name: "TestEvent", data: { signature: transaction.signature } },
        ],
      },
      {
        appendEvents: async (records) => {
          events.push(...records);
        },
      },
      {
        load: async () => cursor,
        compareAndSet: async (_stream, expected, next) => {
          if (cursor !== expected) return false;
          cursor = next;
          return true;
        },
      },
      { address: "program", stream: "events", pageSize: 2, maxPages: 3 },
    );
    const result = await indexer.sync();
    assert.equal(result.indexed, 3);
    assert.deepEqual(events.map((event) => event.signature), ["s1", "s2", "s3"]);
    assert.deepEqual(cursor, { signature: "s3", slot: 3n });
  });

  it("rejects a cursor whose signature reappears at a different slot", async () => {
    const expected = { signature: "cursor", slot: 10n } as const;
    const indexer = new SolanaEventIndexer(
      {
        getProgramAccounts: async () => ({ contextSlot: 0n, accounts: [] }),
        getSignaturesForAddress: async () => [
          { signature: "cursor", slot: 11n, failed: false, blockTimeMs: null },
        ],
        getTransaction: async () => null,
      },
      { decodeAccount: () => null, decodeEvents: () => [] },
      { appendEvents: async () => undefined },
      { load: async () => expected, compareAndSet: async () => true },
      { address: "program", stream: "events" },
    );
    await assert.rejects(indexer.sync(), EventCursorGapError);
  });
});
