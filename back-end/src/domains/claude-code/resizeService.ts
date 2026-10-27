/**
 * C16: continue a Claude Code session in a sandbox of another size.
 *
 *   POST /:taskId/resize ──► performSandboxResize (providers/codeSessions/sandboxResize)
 *                              └─ create = this domain's createSession (same session,
 *                                 lease and project; goal = the resize turn)
 */
import {
  closeTaskForResize,
  performSandboxResize,
  stopSandboxCli,
  type PerformResizeResult,
} from '../../providers/codeSessions/sandboxResize';
import { createSession } from './service';
import type { CreateSessionResult } from './types';

export async function resizeSession(
  taskId: string,
  requestId: string
): Promise<PerformResizeResult<CreateSessionResult>> {
  return performSandboxResize({
    taskId,
    requestId,
    stopCli: stopSandboxCli,
    closeTask: closeTaskForResize,
    create: (input) =>
      createSession({
        agent_id: input.agentId,
        goal: input.goal,
        user_id: input.userId,
        code_session_id: input.codeSessionId,
        lease_owner: input.leaseOwner,
        ...(input.projectId !== null ? { project_id: input.projectId } : {}),
      }),
  });
}
