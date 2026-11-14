import { getBrowserCaptchaTelemetry } from '../../providers/browser';
import {
  probeCookieVariant,
  searchAndPromoteBrowserConfig,
} from '../../providers/browser/challengeRecovery';
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

export async function probeBrowserCookieVariant(input: {
  taskId: string;
  userId?: string;
  currentUrl: string;
  storageState: Record<string, unknown>;
  userAgent?: string;
  blockedResourceUrl?: string;
  recoveryReason?: string | null;
  blockedConfigKeys?: string[];
}) {
  await requireOwnedTask(input.taskId, input.userId);
  return probeCookieVariant({
    taskId: input.taskId,
    userId: input.userId,
    targetUrl: input.currentUrl,
    storageState: input.storageState,
    userAgent: input.userAgent,
    blockedResourceUrl: input.blockedResourceUrl,
    recoveryReason: input.recoveryReason,
    blockedConfigKeys: input.blockedConfigKeys,
  });
}

export async function recoverBrowserChallenge(input: {
  signal?: AbortSignal;
  taskId: string;
  userId?: string;
  currentUrl: string;
  storageState: Record<string, unknown>;
  storageLanes?: Array<{ key: string; storageState: Record<string, unknown> }>;
  userAgent?: string;
  blockedResourceUrl?: string;
  recoveryReason?: string | null;
  requirePaymentCdn?: boolean;
  preserveAuth?: boolean;
  blockedConfigKeys?: string[];
}) {
  await requireOwnedTask(input.taskId, input.userId);
  return searchAndPromoteBrowserConfig({
    signal: input.signal,
    taskId: input.taskId,
    userId: input.userId,
    targetUrl: input.currentUrl,
    storageState: input.storageState,
    storageLanes: input.storageLanes,
    userAgent: input.userAgent,
    blockedResourceUrl: input.blockedResourceUrl,
    recoveryReason: input.recoveryReason,
    requirePaymentCdn: input.requirePaymentCdn,
    preserveAuth: input.preserveAuth,
    blockedConfigKeys: input.blockedConfigKeys,
  });
}
