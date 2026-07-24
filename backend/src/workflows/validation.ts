import { createHash } from "node:crypto";

import type { StartWorkflowRequest, WorkflowRetryPolicy } from "./ports.js";

export class WorkflowConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowConfigurationError";
  }
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowConfigurationError(`${field} must be a positive safe integer`);
  }
}

export function deterministicWorkflowId(kind: string, idempotencyKey: string): string {
  if (kind.length === 0 || idempotencyKey.length === 0) {
    throw new WorkflowConfigurationError("workflow kind and idempotency key are required");
  }
  const normalizedKind = kind.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
  const digest = createHash("sha256")
    // Tuple encoding prevents delimiter collisions between kind and key.
    .update(
      JSON.stringify(["alphabasket-workflow-v1", kind, idempotencyKey]),
      "utf8",
    )
    .digest("hex");
  return `alphabasket:${normalizedKind}:${digest}`;
}

export function validateRetryPolicy(policy: WorkflowRetryPolicy): void {
  positiveSafeInteger(policy.initialIntervalMs, "retry.initialIntervalMs");
  positiveSafeInteger(policy.maximumIntervalMs, "retry.maximumIntervalMs");
  positiveSafeInteger(policy.maximumAttempts, "retry.maximumAttempts");
  if (
    !Number.isFinite(policy.backoffCoefficient) ||
    policy.backoffCoefficient < 1
  ) {
    throw new WorkflowConfigurationError(
      "retry.backoffCoefficient must be finite and at least 1",
    );
  }
  if (policy.maximumIntervalMs < policy.initialIntervalMs) {
    throw new WorkflowConfigurationError(
      "retry.maximumIntervalMs must not be below initialIntervalMs",
    );
  }
}

export function validateStartWorkflowRequest(request: StartWorkflowRequest): void {
  if (
    request.workflowId.length === 0 ||
    request.workflowName.length === 0 ||
    request.taskQueue.length === 0
  ) {
    throw new WorkflowConfigurationError(
      "workflowId, workflowName, and taskQueue are required",
    );
  }
  positiveSafeInteger(request.executionTimeoutMs, "executionTimeoutMs");
  validateRetryPolicy(request.retry);
}
