import { captureInProgressWorkflowTools } from './staleWorkflowTools';
import { claimWorkflowReplacement, type WorkflowLaunchConfig } from './workflowReplacementState';

/** Keep a pre-lock tool snapshot only when the claim sealed that same generation. */
export async function captureClaimedStaleWorkflowTools(
  agentId: string,
  claimedStaleWorkflowId: string | null,
  capturedStaleWorkflowId: string | null,
  preClaimSnapshot: Awaited<ReturnType<typeof captureInProgressWorkflowTools>>,
  capture: typeof captureInProgressWorkflowTools = captureInProgressWorkflowTools
): Promise<Awaited<ReturnType<typeof captureInProgressWorkflowTools>>> {
  if (claimedStaleWorkflowId === capturedStaleWorkflowId) return preClaimSnapshot;
  if (claimedStaleWorkflowId === null) return [];
  return capture(agentId, claimedStaleWorkflowId);
}

export async function claimReplacementGeneration(
  agentId: string,
  launchConfig: WorkflowLaunchConfig | undefined,
  expectedWorkflowId: string | null,
  deploymentAttempt: string | undefined
) {
  if (expectedWorkflowId === null) return claimWorkflowReplacement(agentId, launchConfig);
  return claimWorkflowReplacement(agentId, launchConfig, {
    expectedWorkflowId,
    ...(deploymentAttempt === undefined ? {} : { deploymentAttempt }),
  });
}
