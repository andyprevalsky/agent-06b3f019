import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export function findNavigationSession(taskId: string) {
  return prisma.browserSession.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      sessionId: true,
      agentId: true,
      wsUrl: true,
      provider: true,
      status: true,
      controlState: true,
      controlLeaseExpiresAt: true,
      navigationCommand: true,
      context: { select: { userId: true } },
    },
  });
}

/** Compare the entire receipt as well as the live binding. Only one claimant wins. */
export async function swapNavigationCommand(
  taskId: string,
  sessionId: string,
  previous: Prisma.InputJsonValue | null,
  next: Prisma.InputJsonValue
): Promise<boolean> {
  const result = await prisma.browserSession.updateMany({
    where: {
      id: taskId,
      sessionId,
      status: 'ACTIVE',
      controlState: 'USER',
      controlLeaseExpiresAt: { gt: new Date() },
      navigationCommand: { equals: previous === null ? Prisma.DbNull : previous },
    },
    data: { navigationCommand: next },
  });
  return result.count === 1;
}

/** A PAUSED status alone can precede cleanup. Require the successful detach receipt
 * published by the auth-assistance activity, and its still-unanswered request. */
export async function hasDetachedAuthWorker(
  taskId: string,
  sessionId: string,
  agentId: string,
  userId: string
): Promise<boolean> {
  const owner = await prisma.agent.findFirst({
    where: { id: agentId, userId, status: 'PAUSED' },
    select: { id: true },
  });
  if (owner === null) return false;
  const request = await prisma.userAuthAssistanceRequest.findFirst({
    where: {
      browserSessionId: taskId,
      steelSessionId: sessionId,
      agentId,
      userId,
      mode: 'live_view',
      completedAt: null,
      attentionRequest: { userResponse: null },
    },
    select: { id: true, createdAt: true },
  });
  if (request === null) return false;
  const receipt = await prisma.message.findFirst({
    where: {
      agentId,
      createdAt: { gte: request.createdAt },
      AND: [
        { metadata: { path: ['action_type'], equals: 'auth_assistance' } },
        { metadata: { path: ['browser_page_observation', 'phase'], equals: 'park_time' } },
        { metadata: { path: ['browser_page_observation', 'task_id'], equals: taskId } },
        { metadata: { path: ['browser_page_observation', 'session_id'], equals: sessionId } },
        { metadata: { path: ['browser_page_observation', 'request_id'], equals: request.id } },
      ],
    },
    select: { id: true },
  });
  return receipt !== null;
}
