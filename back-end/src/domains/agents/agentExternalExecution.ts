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
