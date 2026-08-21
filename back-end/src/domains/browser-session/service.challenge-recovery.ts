import { getBrowserCaptchaTelemetry } from '../../providers/browser';
import { searchAndPromoteBrowserConfig } from '../../providers/browser/challengeRecovery';
import * as repo from './repo';
import { SessionNotFoundError } from './service.local-storage';

async function requireOwnedTask(taskId: string, userId?: string) {
  const session = await repo.findSessionByTaskId(taskId);
  if (session === null || (userId !== undefined && session.context.userId !== userId)) {
    throw new SessionNotFoundError();
  }
  return session;
}

export async function getChallengeSolverTelemetry(taskId: string, userId?: string) {
  await requireOwnedTask(taskId, userId);
  return getBrowserCaptchaTelemetry(taskId);
}

export async function recoverBrowserChallenge(input: {
  taskId: string;
  userId?: string;
  currentUrl: string;
  storageState: Record<string, unknown>;
  userAgent?: string;
  blockedResourceUrl?: string;
  requirePaymentCdn?: boolean;
}) {
  await requireOwnedTask(input.taskId, input.userId);
  return searchAndPromoteBrowserConfig({
    taskId: input.taskId,
    userId: input.userId,
    targetUrl: input.currentUrl,
    storageState: input.storageState,
    userAgent: input.userAgent,
    blockedResourceUrl: input.blockedResourceUrl,
    requirePaymentCdn: input.requirePaymentCdn,
  });
}
