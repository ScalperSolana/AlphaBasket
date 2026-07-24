import { createHash, randomUUID } from "node:crypto";

import type {
  KeySignerPort,
  SignatureEnvelope,
  SignerAuditEvent,
  SignerAuditSink,
  SignerPolicy,
  SignerRole,
  SigningRequest,
} from "./types.js";

export class SignerPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SignerPolicyError";
  }
}

export interface PolicyEnforcedSignerOptions {
  readonly policies: readonly SignerPolicy[];
  readonly keySigner: KeySignerPort;
  readonly auditSink: SignerAuditSink;
  readonly now?: () => Date;
}

function requirePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SignerPolicyError(`${field} must be a positive safe integer`);
  }
}

function assertRoleSeparation(policies: readonly SignerPolicy[]): void {
  const ownerByKey = new Map<string, SignerRole>();
  for (const policy of policies) {
    if (policy.keyReference.length === 0) {
      throw new SignerPolicyError(`${policy.role} keyReference must not be empty`);
    }
    const existingOwner = ownerByKey.get(policy.keyReference);
    if (existingOwner !== undefined && existingOwner !== policy.role) {
      throw new SignerPolicyError(
        `key reference ${policy.keyReference} is assigned to both ${existingOwner} and ${policy.role}`,
      );
    }
    ownerByKey.set(policy.keyReference, policy.role);
  }
}

function requiredAlgorithm(role: SignerRole): SignerPolicy["algorithm"] {
  return role === "polymarket_order" ? "secp256k1" : "ed25519";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}

function validateSignatureShape(
  policy: SignerPolicy,
  signature: Uint8Array,
  publicKey: Uint8Array,
): void {
  if (policy.algorithm === "ed25519") {
    if (signature.byteLength !== 64 || publicKey.byteLength !== 32) {
      throw new Error("key signer returned an invalid Ed25519 signature or public key");
    }
  } else if (
    signature.byteLength !== 65 ||
    (publicKey.byteLength !== 33 && publicKey.byteLength !== 65)
  ) {
    throw new Error("key signer returned an invalid secp256k1 signature or public key");
  }

  if (
    policy.expectedPublicKey !== undefined &&
    !equalBytes(policy.expectedPublicKey, publicKey)
  ) {
    throw new Error("key signer returned a public key that does not match policy");
  }
}

function assertRequiredContext(
  policy: SignerPolicy,
  request: SigningRequest,
): void {
  for (const field of policy.requiredContext) {
    const value = request.context[field];
    if (value === undefined || value.length === 0) {
      throw new SignerPolicyError(`${request.role} signing requires context.${field}`);
    }
  }
}

function auditEvent(
  request: SigningRequest,
  payloadHash: string,
  occurredAt: Date,
  outcome: SignerAuditEvent["outcome"],
  policy: SignerPolicy | undefined,
  reason?: string,
): SignerAuditEvent {
  return {
    id: randomUUID(),
    role: request.role,
    ...(policy === undefined
      ? {}
      : {
          keyReference: policy.keyReference,
          algorithm: policy.algorithm,
        }),
    domain: request.context.domain,
    action: request.context.action,
    network: request.context.network,
    payloadHash,
    payloadBytes: request.payload.byteLength,
    outcome,
    ...(reason === undefined ? {} : { reason }),
    occurredAt,
  };
}

export class PolicyEnforcedSigner {
  private readonly policies: ReadonlyMap<SignerRole, SignerPolicy>;
  private readonly now: () => Date;

  public constructor(private readonly options: PolicyEnforcedSignerOptions) {
    assertRoleSeparation(options.policies);
    const policies = new Map<SignerRole, SignerPolicy>();
    for (const policy of options.policies) {
      requirePositiveSafeInteger(policy.maxPayloadBytes, "maxPayloadBytes");
      if (policy.maxExpiryMs !== undefined) {
        requirePositiveSafeInteger(policy.maxExpiryMs, "maxExpiryMs");
      }
      if (policies.has(policy.role)) {
        throw new SignerPolicyError(`duplicate policy for role ${policy.role}`);
      }
      if (policy.algorithm !== requiredAlgorithm(policy.role)) {
        throw new SignerPolicyError(
          `${policy.role} must use ${requiredAlgorithm(policy.role)}`,
        );
      }
      policies.set(policy.role, policy);
    }
    this.policies = policies;
    this.now = options.now ?? (() => new Date());
  }

  public async sign(request: SigningRequest): Promise<SignatureEnvelope> {
    const payload = Uint8Array.from(request.payload);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const now = this.now();
    const policy = this.policies.get(request.role);

    try {
      if (policy === undefined) {
        throw new SignerPolicyError(`no signing policy for role ${request.role}`);
      }
      this.assertAllowed(policy, { ...request, payload }, now);

      const result = await this.options.keySigner.sign({
        keyReference: policy.keyReference,
        algorithm: policy.algorithm,
        payload,
      });
      validateSignatureShape(policy, result.signature, result.publicKey);
      await this.options.auditSink.record(
        auditEvent(request, payloadHash, now, "signed", policy),
      );

      return {
        signature: Uint8Array.from(result.signature),
        publicKey: Uint8Array.from(result.publicKey),
        role: request.role,
        keyReference: policy.keyReference,
        algorithm: policy.algorithm,
        payloadHash,
        signedAt: new Date(now),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown signing failure";
      const outcome = error instanceof SignerPolicyError ? "denied" : "failed";
      await this.options.auditSink.record(
        auditEvent(request, payloadHash, now, outcome, policy, reason),
      );
      throw error;
    }
  }

  private assertAllowed(
    policy: SignerPolicy,
    request: SigningRequest,
    now: Date,
  ): void {
    if (request.payload.byteLength === 0) {
      throw new SignerPolicyError("signing payload must not be empty");
    }
    if (request.payload.byteLength > policy.maxPayloadBytes) {
      throw new SignerPolicyError("signing payload exceeds policy size limit");
    }
    if (!policy.allowedDomains.has(request.context.domain)) {
      throw new SignerPolicyError("signing domain is not allowed for this role");
    }
    if (!policy.allowedActions.has(request.context.action)) {
      throw new SignerPolicyError("signing action is not allowed for this role");
    }
    if (!policy.allowedNetworks.has(request.context.network)) {
      throw new SignerPolicyError("signing network is not allowed for this role");
    }
    assertRequiredContext(policy, request);
    try {
      policy.validatePayload(
        Uint8Array.from(request.payload),
        request.context,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "payload validation failed";
      throw new SignerPolicyError(`canonical payload rejected: ${reason}`);
    }

    const expiry = request.context.expiresAt;
    if (policy.requireExpiry && expiry === undefined) {
      throw new SignerPolicyError("signing request requires an expiry");
    }
    if (expiry !== undefined) {
      const expiryMs = expiry.getTime();
      const nowMs = now.getTime();
      if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) {
        throw new SignerPolicyError("signing request is expired");
      }
      if (
        policy.maxExpiryMs !== undefined &&
        expiryMs - nowMs > policy.maxExpiryMs
      ) {
        throw new SignerPolicyError("signing request expiry exceeds policy limit");
      }
    }
  }
}
