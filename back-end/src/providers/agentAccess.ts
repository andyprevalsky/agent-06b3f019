import type { AuthRequest } from './auth';
import { prisma } from './database';

/**
 * Whether the caller may read or act on `agentId`: the internal API key reaches
 * every agent, a user JWT only the agents it owns. One primary-key read.
 */
export async function callerCanAccessAgent(req: AuthRequest, agentId: string): Promise<boolean> {
  if (req.isInternal === true) return true;
  const userId = req.user?.id;
  if (userId === undefined) return false;
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
  return agent !== null && agent.userId === userId;
}

/** Whether the caller may read code-session task `taskId` (its agent's owner, or internal). */
export async function callerCanAccessCodeTask(req: AuthRequest, taskId: string): Promise<boolean> {
  if (req.isInternal === true) return true;
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { agentId: true },
  });
  return task !== null && callerCanAccessAgent(req, task.agentId);
}
