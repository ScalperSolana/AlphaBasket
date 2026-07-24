export const SIGNER_ROLES = [
  "composer",
  "solana_completion",
  "nav_quote",
  "polymarket_order",
  "solana_settlement",
] as const;

export type SignerRole = (typeof SIGNER_ROLES)[number];
export type SigningAlgorithm = "ed25519" | "secp256k1";

export interface SigningContext {
  readonly domain: string;
  readonly action: string;
  readonly network: string;
  readonly expiresAt?: Date;
  readonly basketId?: string;
  readonly programId?: string;
  readonly intentHash?: string;
}

export interface SigningRequest {
  readonly role: SignerRole;
  readonly payload: Uint8Array;
  readonly context: SigningContext;
}

export interface SignerPolicy {
  readonly role: SignerRole;
  readonly keyReference: string;
  readonly algorithm: SigningAlgorithm;
  readonly expectedPublicKey?: Uint8Array;
  readonly allowedDomains: ReadonlySet<string>;
  readonly allowedActions: ReadonlySet<string>;
  readonly allowedNetworks: ReadonlySet<string>;
  readonly maxPayloadBytes: number;
  readonly requireExpiry: boolean;
  readonly maxExpiryMs?: number;
  readonly requiredContext: ReadonlySet<"basketId" | "programId" | "intentHash">;
  readonly validatePayload: (
    payload: Uint8Array,
    context: SigningContext,
  ) => void;
}

export interface KeySigningRequest {
  readonly keyReference: string;
  readonly algorithm: SigningAlgorithm;
  readonly payload: Uint8Array;
}

export interface KeySignature {
  readonly signature: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface KeySignerPort {
  sign(request: KeySigningRequest): Promise<KeySignature>;
}

export interface SignatureEnvelope extends KeySignature {
  readonly role: SignerRole;
  readonly keyReference: string;
  readonly algorithm: SigningAlgorithm;
  readonly payloadHash: string;
  readonly signedAt: Date;
}

export type SignerAuditOutcome = "signed" | "denied" | "failed";

export interface SignerAuditEvent {
  readonly id: string;
  readonly role: SignerRole;
  readonly keyReference?: string;
  readonly algorithm?: SigningAlgorithm;
  readonly domain: string;
  readonly action: string;
  readonly network: string;
  readonly payloadHash: string;
  readonly payloadBytes: number;
  readonly outcome: SignerAuditOutcome;
  readonly reason?: string;
  readonly occurredAt: Date;
}

export interface SignerAuditSink {
  record(event: SignerAuditEvent): Promise<void>;
}
