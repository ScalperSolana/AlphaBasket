export interface WorkflowRetryPolicy {
  readonly initialIntervalMs: number;
  readonly backoffCoefficient: number;
  readonly maximumIntervalMs: number;
  readonly maximumAttempts: number;
  readonly nonRetryableErrorTypes: readonly string[];
}

import type { EncodedWorkflowPayload } from "./payload-codec.js";

export interface StartWorkflowRequest {
  readonly workflowId: string;
  readonly workflowName: string;
  readonly taskQueue: string;
  readonly input: EncodedWorkflowPayload;
  readonly retry: WorkflowRetryPolicy;
  readonly executionTimeoutMs: number;
  /** Financial workflows never reuse IDs after failure: failure may follow an external side effect. */
  readonly idReusePolicy: "reject_duplicate";
  readonly memo?: Readonly<Record<string, string>>;
}

export interface WorkflowHandle {
  readonly workflowId: string;
  readonly runId?: string;
  result(): Promise<EncodedWorkflowPayload>;
  signal(name: string, payload: EncodedWorkflowPayload): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface WorkflowClientPort {
  start(request: StartWorkflowRequest): Promise<WorkflowHandle>;
  getHandle(workflowId: string, runId?: string): WorkflowHandle;
}

export interface ActivityHeartbeatPort {
  heartbeat(details?: EncodedWorkflowPayload): void;
}

export interface ActivityExecutionContext extends ActivityHeartbeatPort {
  readonly workflowId: string;
  readonly runId: string;
  readonly activityId: string;
  readonly attempt: number;
  readonly cancellationSignal: AbortSignal;
}

export interface WorkflowActivityPort {
  execute(
    input: EncodedWorkflowPayload,
    context: ActivityExecutionContext,
  ): Promise<EncodedWorkflowPayload>;
}

export interface WorkflowClockPort {
  now(): Date;
  sleep(durationMs: number): Promise<void>;
}
