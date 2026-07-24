export interface SolanaProgramAccount {
  readonly address: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

export interface ProgramAccountSnapshot {
  readonly contextSlot: bigint;
  readonly accounts: readonly SolanaProgramAccount[];
}

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: bigint;
  readonly failed: boolean;
  readonly blockTimeMs: bigint | null;
}

export interface SolanaTransaction {
  readonly signature: string;
  readonly slot: bigint;
  readonly blockTimeMs: bigint | null;
  readonly payload: unknown;
}

export interface SolanaReadRpcPort {
  getProgramAccounts(programId: string): Promise<ProgramAccountSnapshot>;
  getSignaturesForAddress(
    address: string,
    options: { readonly before: string | null; readonly limit: number },
  ): Promise<readonly SignatureInfo[]>;
  getTransaction(signature: string): Promise<SolanaTransaction | null>;
}

export interface DecodedAccount {
  readonly kind: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface DecodedEvent {
  readonly name: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface SolanaProgramDecoderPort {
  decodeAccount(account: SolanaProgramAccount): DecodedAccount | null;
  decodeEvents(transaction: SolanaTransaction): readonly DecodedEvent[];
}

export interface IndexedAccountRecord extends DecodedAccount {
  readonly address: string;
  readonly owner: string;
  readonly lamports: bigint;
  readonly sourceSlot: bigint;
}

export interface IndexedEventRecord extends DecodedEvent {
  readonly id: string;
  readonly signature: string;
  readonly eventIndex: number;
  readonly sourceSlot: bigint;
  readonly blockTimeMs: bigint | null;
}

export interface AccountProjectionSinkPort {
  /**
   * Must be idempotent by address and ignore a record whose sourceSlot is older
   * than the record already stored for that address. This prevents concurrent
   * snapshots from rolling projections backwards.
   */
  applySnapshotMonotonic(
    programId: string,
    sourceSlot: bigint,
    records: readonly IndexedAccountRecord[],
  ): Promise<void>;
}

export interface EventSinkPort {
  /** Must be idempotent by event id. */
  appendEvents(records: readonly IndexedEventRecord[]): Promise<void>;
}

export interface EventCursor {
  readonly signature: string;
  readonly slot: bigint;
}

export interface AccountCursorStorePort {
  load(stream: string): Promise<bigint | null>;
  compareAndSet(stream: string, expected: bigint | null, next: bigint): Promise<boolean>;
}

export interface EventCursorStorePort {
  load(stream: string): Promise<EventCursor | null>;
  compareAndSet(
    stream: string,
    expected: EventCursor | null,
    next: EventCursor,
  ): Promise<boolean>;
}

export interface SyncResult {
  readonly indexed: number;
  readonly cursorAdvanced: boolean;
}
