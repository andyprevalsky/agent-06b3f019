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
  // Snapshot claims (deploy migrate) pass deploymentAttempt so a FAILED/COMPLETED
  // race between snapshot and claim is skipped. User-initiated restart — including
  // recovering an agent that force-clear previously marked FAILED — must not use
  // that skip, or a late approval can never revive the sealed generation.
  if (expectedWorkflowId === null || deploymentAttempt === undefined) {
    return claimWorkflowReplacement(agentId, launchConfig);
  }
  return claimWorkflowReplacement(agentId, launchConfig, {
    expectedWorkflowId,
    deploymentAttempt,
  });
}
