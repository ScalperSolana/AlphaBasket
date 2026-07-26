import type { KeySignerPort, SigningAlgorithm } from "../signer/types.js";

export const REMOTE_SIGNER_REQUEST_VERSION = "1";
export const REMOTE_SIGNER_MAXIMUM_PAYLOAD_BYTES = 8_192;

export interface RemoteSignerKeyIdentity {
  readonly keyReference: string;
  readonly algorithm: SigningAlgorithm;
  readonly publicKey: Uint8Array;
}

export interface RemoteSignerKeyProvider extends KeySignerPort {
  identities(): readonly RemoteSignerKeyIdentity[];
}

export class RemoteSignerAccessError extends Error {
  public constructor(message = "signing request denied") {
    super(message);
    this.name = "RemoteSignerAccessError";
  }
}

export interface RemoteSignerAuditEvent {
  readonly requestId: string;
  readonly keyReference: string | null;
  readonly algorithm: SigningAlgorithm | null;
  readonly payloadHash: string | null;
  readonly outcome: "signed" | "denied" | "failed";
  readonly occurredAt: Date;
  readonly reason?: string;
}

export interface RemoteSignerAuditSink {
  record(event: RemoteSignerAuditEvent): void;
}
