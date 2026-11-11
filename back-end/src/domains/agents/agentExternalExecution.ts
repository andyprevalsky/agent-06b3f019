import type { CreateAgentBody } from './types';

export function incompatibleExternalLaunch(body: CreateAgentBody): boolean {
  return (
    body.parent_agent_id !== undefined ||
    body.parent_workflow_id !== undefined ||
    body.start_phase !== undefined ||
    body.depth !== 0 ||
    body.bus_id !== undefined ||
    body.pause_state === true ||
    body.share_code_session_with !== undefined
  );
}

export function assertExternalExecution(
  body: CreateAgentBody,
  internal: boolean,
  external?: boolean
): void {
  if (external === true && (!internal || incompatibleExternalLaunch(body))) {
    throw new Error(
      'External execution requires an internal independent root without launch options'
    );
  }
}

/**
 * Recorded as an external root's start phase in its create transaction: its
 * internal executor, not chat or Temporal, is the root's only execution owner.
 * External roots reject a public start_phase, so this never collides with a
 * plan/execute start.
 */
export const EXTERNAL_EXECUTION_START_PHASE = 'external';

/**
 * External roots never gain a chat or Temporal lifecycle: in any status (ACTIVE,
 * PAUSED or terminal) a follow-up is stored for the executor's trace, never
 * dispatched, so no competing handler can start beside or after the executor.
 */
export function ownedByExternalExecution(agent: { workflowStartPhase: string | null }): boolean {
  return agent.workflowStartPhase === EXTERNAL_EXECUTION_START_PHASE;
}
