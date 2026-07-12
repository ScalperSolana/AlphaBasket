import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemorySignerAuditSink,
  PolicyEnforcedSigner,
  SignerPolicyError,
} from "../src/signer/index.js";
import type {
  KeySignerPort,
  SignerPolicy,
  SigningContext,
} from "../src/signer/index.js";

const NOW = new Date("2026-07-12T10:00:00.000Z");

class FakeKeySigner implements KeySignerPort {
  public readonly requests: Array<{
    readonly keyReference: string;
    readonly payload: Uint8Array;
  }> = [];

  public constructor(
    private readonly publicKey = new Uint8Array(32).fill(7),
    private readonly signature = new Uint8Array(64).fill(8),
  ) {}

  public async sign(request: {
    readonly keyReference: string;
    readonly algorithm: "ed25519" | "secp256k1";
    readonly payload: Uint8Array;
  }): Promise<{ readonly signature: Uint8Array; readonly publicKey: Uint8Array }> {
    this.requests.push({
      keyReference: request.keyReference,
      payload: Uint8Array.from(request.payload),
    });
    return {
      signature: Uint8Array.from(this.signature),
      publicKey: Uint8Array.from(this.publicKey),
    };
  }
}

function context(overrides: Partial<SigningContext> = {}): SigningContext {
  return {
    domain: "alphabasket:completion:v1",
    action: "complete_deposit",
    network: "solana-mainnet",
    basketId: "basket-a",
    programId: "program-a",
    intentHash: "intent-a",
    expiresAt: new Date(NOW.getTime() + 30_000),
    ...overrides,
  };
}

function completionPolicy(overrides: Partial<SignerPolicy> = {}): SignerPolicy {
  return {
    role: "solana_completion",
    keyReference: "kms://solana-completion",
    algorithm: "ed25519",
    expectedPublicKey: new Uint8Array(32).fill(7),
    allowedDomains: new Set(["alphabasket:completion:v1"]),
    allowedActions: new Set(["complete_deposit", "complete_withdrawal"]),
    allowedNetworks: new Set(["solana-mainnet"]),
    maxPayloadBytes: 1_024,
    requireExpiry: true,
    maxExpiryMs: 60_000,
    requiredContext: new Set(["basketId", "programId", "intentHash"]),
    validatePayload: (payload, signingContext) => {
      const decoded = new TextDecoder().decode(payload);
      if (decoded !== `${signingContext.domain}|${signingContext.action}`) {
        throw new Error("payload context mismatch");
      }
    },
    ...overrides,
  };
}

function payload(signingContext: SigningContext): Uint8Array {
  return new TextEncoder().encode(
    `${signingContext.domain}|${signingContext.action}`,
  );
}

describe("policy-enforced role-separated signing", () => {
  it("resolves the role-owned key and validates the canonical payload", async () => {
    const keySigner = new FakeKeySigner();
    const audit = new InMemorySignerAuditSink();
    const signer = new PolicyEnforcedSigner({
      policies: [completionPolicy()],
      keySigner,
      auditSink: audit,
      now: () => NOW,
    });
    const signingContext = context();
    const envelope = await signer.sign({
      role: "solana_completion",
      payload: payload(signingContext),
      context: signingContext,
    });

    assert.equal(keySigner.requests[0]?.keyReference, "kms://solana-completion");
    assert.equal(envelope.signature.byteLength, 64);
    assert.equal(envelope.publicKey.byteLength, 32);
    assert.equal(audit.events[0]?.outcome, "signed");
  });

  it("denies an action before invoking the key signer and audits the denial", async () => {
    const keySigner = new FakeKeySigner();
    const audit = new InMemorySignerAuditSink();
    const signer = new PolicyEnforcedSigner({
      policies: [completionPolicy()],
      keySigner,
      auditSink: audit,
      now: () => NOW,
    });
    const signingContext = context({ action: "set_admin" });
    await assert.rejects(
      signer.sign({
        role: "solana_completion",
        payload: payload(signingContext),
        context: signingContext,
      }),
      SignerPolicyError,
    );
    assert.equal(keySigner.requests.length, 0);
    assert.equal(audit.events[0]?.outcome, "denied");
  });

  it("rejects context that is not cryptographically represented in the payload", async () => {
    const audit = new InMemorySignerAuditSink();
    const signer = new PolicyEnforcedSigner({
      policies: [completionPolicy()],
      keySigner: new FakeKeySigner(),
      auditSink: audit,
      now: () => NOW,
    });
    await assert.rejects(
      signer.sign({
        role: "solana_completion",
        payload: new TextEncoder().encode("unrelated bytes"),
        context: context(),
      }),
      /canonical payload rejected/u,
    );
    assert.equal(audit.events[0]?.outcome, "denied");
  });

  it("rejects expired requests and malformed or unexpected key output", async () => {
    const expiredSigner = new PolicyEnforcedSigner({
      policies: [completionPolicy()],
      keySigner: new FakeKeySigner(),
      auditSink: new InMemorySignerAuditSink(),
      now: () => NOW,
    });
    const expiredContext = context({ expiresAt: new Date(NOW.getTime() - 1) });
    await assert.rejects(
      expiredSigner.sign({
        role: "solana_completion",
        payload: payload(expiredContext),
        context: expiredContext,
      }),
      /expired/u,
    );

    const audit = new InMemorySignerAuditSink();
    const malformedSigner = new PolicyEnforcedSigner({
      policies: [completionPolicy()],
      keySigner: new FakeKeySigner(new Uint8Array(31), new Uint8Array(63)),
      auditSink: audit,
      now: () => NOW,
    });
    const validContext = context();
    await assert.rejects(
      malformedSigner.sign({
        role: "solana_completion",
        payload: payload(validContext),
        context: validContext,
      }),
      /invalid Ed25519/u,
    );
    assert.equal(audit.events[0]?.outcome, "failed");
  });

  it("enforces distinct keys and the chain-specific signing algorithm", () => {
    assert.throws(
      () =>
        new PolicyEnforcedSigner({
          policies: [
            completionPolicy(),
            completionPolicy({
              role: "composer",
              keyReference: "kms://solana-completion",
            }),
          ],
          keySigner: new FakeKeySigner(),
          auditSink: new InMemorySignerAuditSink(),
        }),
      /assigned to both/u,
    );
    assert.throws(
      () =>
        new PolicyEnforcedSigner({
          policies: [completionPolicy({ algorithm: "secp256k1" })],
          keySigner: new FakeKeySigner(),
          auditSink: new InMemorySignerAuditSink(),
        }),
      /must use ed25519/u,
    );
  });
});
