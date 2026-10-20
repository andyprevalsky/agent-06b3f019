/**
 * Code-agent environment size (C16): `rose env status` / `rose env size`.
 *
 *   sandbox token (code_agent caller, one task) ──► requestSandboxResize /
 *   environmentStatus (providers/codeSessions/sandboxSize)
 *
 * Only a code-agent session token names a task; an internal agents-worker
 * caller has no sandbox to resize.
 */
import {
  environmentStatus,
  requestSandboxResize,
  SandboxResizeError,
  type ResizeRequestResult,
} from '../../providers/codeSessions/sandboxSize';
import type { AgentToolsCaller } from './types';

function codeAgentTask(caller: AgentToolsCaller): { userId: string; taskId: string | null } {
  if (caller.kind !== 'code_agent') {
    throw new SandboxResizeError(
      403,
      'NOT_A_CODE_SESSION',
      'Only a code-agent session can read or change its environment size'
    );
  }
  return { userId: caller.userId, taskId: caller.taskId };
}

export async function requestEnvironmentSize(
  caller: AgentToolsCaller,
  body: { cpu?: number; memory_gb?: number; reason?: string }
): Promise<ResizeRequestResult> {
  const { userId, taskId } = codeAgentTask(caller);
  return requestSandboxResize({
    userId,
    agentId: caller.agentId,
    taskId,
    ...(body.cpu !== undefined ? { cpu: body.cpu } : {}),
    ...(body.memory_gb !== undefined ? { memoryGb: body.memory_gb } : {}),
    reason: body.reason ?? '',
  });
}

export async function readEnvironment(caller: AgentToolsCaller): Promise<Record<string, unknown>> {
  const { userId, taskId } = codeAgentTask(caller);
  return environmentStatus({ userId, agentId: caller.agentId, taskId });
}
