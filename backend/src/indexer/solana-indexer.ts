import type {
  AccountCursorStorePort,
  AccountProjectionSinkPort,
  EventCursor,
  EventCursorStorePort,
  EventSinkPort,
  IndexedAccountRecord,
  IndexedEventRecord,
  SignatureInfo,
  SolanaProgramDecoderPort,
  SolanaReadRpcPort,
  SyncResult,
} from "./types.js";

export class CursorConflictError extends Error {
  public constructor(stream: string) {
    super(`Indexer cursor changed concurrently for stream ${stream}`);
    this.name = "CursorConflictError";
  }
}

export class EventCursorGapError extends Error {
  public constructor(stream: string, signature: string) {
    super(`Event cursor ${signature} was not found within the scan window for stream ${stream}`);
    this.name = "EventCursorGapError";
  }
}

export class EventBackfillTruncatedError extends Error {
  public constructor(stream: string, maxPages: number) {
    super(`Initial event backfill for ${stream} exceeded the configured ${maxPages} page scan window`);
    this.name = "EventBackfillTruncatedError";
  }
}

export class TransactionUnavailableError extends Error {
  public constructor(signature: string) {
    super(`Confirmed Solana transaction ${signature} is unavailable`);
    this.name = "TransactionUnavailableError";
  }
}

export interface SolanaAccountIndexerOptions {
  readonly programId: string;
  readonly stream: string;
}

export class SolanaAccountIndexer {
  public constructor(
    private readonly rpc: SolanaReadRpcPort,
    private readonly decoder: SolanaProgramDecoderPort,
    private readonly sink: AccountProjectionSinkPort,
    private readonly cursors: AccountCursorStorePort,
    private readonly options: SolanaAccountIndexerOptions,
  ) {}

  public async sync(): Promise<SyncResult> {
    const expectedCursor = await this.cursors.load(this.options.stream);
    const snapshot = await this.rpc.getProgramAccounts(this.options.programId);

    if (expectedCursor !== null && snapshot.contextSlot <= expectedCursor) {
      return Object.freeze({ indexed: 0, cursorAdvanced: false });
    }

    const records: IndexedAccountRecord[] = [];
    for (const account of snapshot.accounts) {
      const decoded = this.decoder.decodeAccount(account);
      if (decoded === null) {
        continue;
      }
      records.push(
        Object.freeze({
          address: account.address,
          owner: account.owner,
          lamports: account.lamports,
          sourceSlot: snapshot.contextSlot,
          kind: decoded.kind,
          data: Object.freeze({ ...decoded.data }),
        }),
      );
    }

    // Writing before the cursor means a crash can only replay records. The monotonic
    // sink contract additionally prevents an older concurrent snapshot from rolling
    // an already-projected account back to a lower source slot.
    await this.sink.applySnapshotMonotonic(
      this.options.programId,
      snapshot.contextSlot,
      Object.freeze(records),
    );
    const advanced = await this.cursors.compareAndSet(
      this.options.stream,
      expectedCursor,
      snapshot.contextSlot,
    );
    if (!advanced) {
      throw new CursorConflictError(this.options.stream);
    }

    return Object.freeze({ indexed: records.length, cursorAdvanced: true });
  }
}

export interface SolanaEventIndexerOptions {
  readonly address: string;
  readonly stream: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
  /** Backfill is the safe default. start-latest intentionally ignores existing history. */
  readonly bootstrapPolicy?: "backfill" | "start-latest";
}

const sameCursor = (left: EventCursor | null, right: EventCursor | null): boolean =>
  left === null
    ? right === null
    : right !== null && left.signature === right.signature && left.slot === right.slot;

export class SolanaEventIndexer {
  private readonly pageSize: number;
  private readonly maxPages: number;

  public constructor(
    private readonly rpc: SolanaReadRpcPort,
    private readonly decoder: SolanaProgramDecoderPort,
    private readonly sink: EventSinkPort,
    private readonly cursors: EventCursorStorePort,
    private readonly options: SolanaEventIndexerOptions,
  ) {
    this.pageSize = options.pageSize ?? 100;
    this.maxPages = options.maxPages ?? 20;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0 || this.pageSize > 1_000) {
      throw new RangeError("pageSize must be an integer between 1 and 1000");
    }
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages <= 0) {
      throw new RangeError("maxPages must be a positive integer");
    }
  }

  public async sync(): Promise<SyncResult> {
    const expectedCursor = await this.cursors.load(this.options.stream);
    if (expectedCursor === null && this.options.bootstrapPolicy === "start-latest") {
      return this.bootstrapAtLatest();
    }
    const signatures = await this.scanNewSignatures(expectedCursor);
    if (signatures.length === 0) {
      return Object.freeze({ indexed: 0, cursorAdvanced: false });
    }

    const records: IndexedEventRecord[] = [];
    for (const info of [...signatures].reverse()) {
      if (info.failed) {
        continue;
      }
      const transaction = await this.rpc.getTransaction(info.signature);
      if (transaction === null) {
        throw new TransactionUnavailableError(info.signature);
      }
      if (transaction.slot !== info.slot) {
        throw new Error(
          `Solana transaction ${info.signature} slot ${transaction.slot.toString()} does not match signature slot ${info.slot.toString()}`,
        );
      }
      const events = this.decoder.decodeEvents(transaction);
      events.forEach((event, eventIndex) => {
        records.push(
          Object.freeze({
            id: `${info.signature}:${eventIndex}`,
            signature: info.signature,
            eventIndex,
            sourceSlot: info.slot,
            blockTimeMs: info.blockTimeMs,
            name: event.name,
            data: Object.freeze({ ...event.data }),
          }),
        );
      });
    }

    await this.sink.appendEvents(Object.freeze(records));
    const newest = signatures[0];
    if (newest === undefined) {
      throw new Error("unreachable: non-empty signature scan had no newest entry");
    }
    const nextCursor = Object.freeze({ signature: newest.signature, slot: newest.slot });
    const advanced = await this.cursors.compareAndSet(
      this.options.stream,
      expectedCursor,
      nextCursor,
    );
    if (!advanced) {
      throw new CursorConflictError(this.options.stream);
    }

    return Object.freeze({ indexed: records.length, cursorAdvanced: true });
  }

  private async bootstrapAtLatest(): Promise<SyncResult> {
    const latest = await this.rpc.getSignaturesForAddress(this.options.address, {
      before: null,
      limit: 1,
    });
    const newest = latest[0];
    if (newest === undefined) {
      return Object.freeze({ indexed: 0, cursorAdvanced: false });
    }
    const advanced = await this.cursors.compareAndSet(
      this.options.stream,
      null,
      Object.freeze({ signature: newest.signature, slot: newest.slot }),
    );
    if (!advanced) {
      throw new CursorConflictError(this.options.stream);
    }
    return Object.freeze({ indexed: 0, cursorAdvanced: true });
  }

  private async scanNewSignatures(cursor: EventCursor | null): Promise<SignatureInfo[]> {
    const collected: SignatureInfo[] = [];
    let before: string | null = null;
    let foundCursor = false;
    let reachedHistoryEnd = false;

    for (let page = 0; page < this.maxPages; page += 1) {
      const batch = await this.rpc.getSignaturesForAddress(this.options.address, {
        before,
        limit: this.pageSize,
      });
      if (batch.length === 0) {
        reachedHistoryEnd = true;
        break;
      }

      for (const info of batch) {
        if (cursor !== null && info.signature === cursor.signature) {
          if (info.slot !== cursor.slot) {
            throw new EventCursorGapError(this.options.stream, cursor.signature);
          }
          foundCursor = true;
          break;
        }
        collected.push(info);
      }
      if (cursor !== null && foundCursor) {
        break;
      }

      const oldest = batch[batch.length - 1];
      if (oldest === undefined || batch.length < this.pageSize) {
        reachedHistoryEnd = true;
        break;
      }
      before = oldest.signature;
    }

    if (!foundCursor && cursor !== null) {
      throw new EventCursorGapError(this.options.stream, cursor.signature);
    }
    if (cursor === null && !reachedHistoryEnd) {
      throw new EventBackfillTruncatedError(this.options.stream, this.maxPages);
    }
    return collected;
  }
}

export const eventCursorsEqual = sameCursor;
