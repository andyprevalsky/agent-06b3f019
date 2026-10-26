/**
 * C16: continue a Codex session in a sandbox of another size.
 *
 *   POST /:taskId/resize ──► performSandboxResize (providers/codeSessions/sandboxResize)
 *                              └─ create = this domain's createSession (same session
 *                                 and lease; goal = the resize turn)
 */
import {
  closeTaskForResize,
  performSandboxResize,
  stopSandboxCli,
} from '../../providers/codeSessions/sandboxResize';
import { createSession } from './service';

export async function resizeSession(taskId: string, requestId: string) {
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
      }),
  });
}
