import { proxyActivities } from "@temporalio/workflow";

import type { EncodedWorkflowPayload } from "./payload-codec.js";

interface FinancialActivities {
  executeFinancialOperation(
    input: EncodedWorkflowPayload,
  ): Promise<EncodedWorkflowPayload>;
}

const activities = proxyActivities<FinancialActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 100,
    nonRetryableErrorTypes: ["TypeError", "RangeError", "SignerPolicyError"],
  },
});

export async function depositExecutionWorkflow(
  input: EncodedWorkflowPayload,
): Promise<EncodedWorkflowPayload> {
  return activities.executeFinancialOperation(input);
}

export async function withdrawalExecutionWorkflow(
  input: EncodedWorkflowPayload,
): Promise<EncodedWorkflowPayload> {
  return activities.executeFinancialOperation(input);
}
