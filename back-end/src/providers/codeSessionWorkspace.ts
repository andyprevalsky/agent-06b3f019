/**
 * Everything a code-agent session gets in its HOME, assembled in one place:
 *
 *   prepareUserUiWorkspaceSafe(userId)      rose_user_ui/ + rose-ui CLI     (W1)
 *     └─ withAgentGraphWorkspace(...)       rose-agents CLI + graph token   (L-A2A)
 *          └─ withAgentTools(...)           rose CLI / MCP + tools token    (L-DISPLAY)
 *
 * Each step is best-effort (never throws); a failed step leaves the others.
 */
import { withAgentGraphWorkspace } from './agentGraph/workspace';
import { withAgentTools } from './agentTools/workspace';
import { prepareUserUiWorkspaceSafe, type UserUiWorkspace } from './userUi/workspace';

export async function prepareCodeSessionWorkspace(
  userId: string | undefined,
  agentId: string,
  taskId: string,
  provider: 'claude' | 'codex'
): Promise<UserUiWorkspace | null> {
  const graph = await withAgentGraphWorkspace(await prepareUserUiWorkspaceSafe(userId), {
    userId,
    ownerAgentId: agentId,
    sessionId: taskId,
    provider,
  });
  return withAgentTools(graph, { userId, agentId, taskId, provider });
}
