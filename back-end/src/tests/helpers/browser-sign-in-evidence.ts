import { createRequest } from '../../domains/auth-assistance/repo';
import type { AuthAssistanceMode } from '../../domains/auth-assistance/types';
import { completeAuthAssistanceForUser } from '../../providers/authAssistanceCompletion';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';

/**
 * Record a user sign-in inside a cloud browser session through the production
 * auth-assistance create + complete path, minus the Temporal signal/resume.
 */
export async function completeCloudBrowserSignIn(params: {
  userId: string;
  agentId: string;
  browserSessionId: string;
  steelSessionId: string;
  authRealm: string;
  mode?: AuthAssistanceMode;
  complete?: boolean;
}): Promise<string> {
  const request = await createRequest({
    agentId: params.agentId,
    userId: params.userId,
    workflowId: params.agentId,
    authRealm: params.authRealm,
    mode: params.mode ?? 'live_view',
    browserSessionId: params.browserSessionId,
    steelSessionId: params.steelSessionId,
    liveViewUrl: null,
  });
  if (params.complete === false) return request.id;
  const result = await completeAuthAssistanceForUser(request.id, params.userId, new Date(), {
    signalCompleted: async () => undefined,
    resumeAgent: async () => ({ error: 'resume disabled in test fixture', status: 409 }),
  });
  if (result.status !== 'completed') {
    throw new Error(`auth assistance ${request.id} did not complete: ${result.status}`);
  }
  return request.id;
}

export async function deleteCloudBrowserSignInEvidence(userId: string): Promise<void> {
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
}

/** Holds the advisory lock a sibling close of the same user would hold. */
export async function holdSiblingCloseLock(key: string) {
  let acquired!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (acquired = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  let valveFired = false;
  // Only an unbounded write is still waiting when this valve opens.
  const valve = setTimeout(() => {
    valveFired = true;
    release();
  }, 15_000);
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      acquired();
      await released;
    },
    { maxWait: 5_000, timeout: 30_000 }
  );
  await Promise.race([held, holder]);
  return {
    valveFired: () => valveFired,
    release: async () => {
      clearTimeout(valve);
      release();
      await holder;
    },
  };
}

/** A write abandoned at the close deadline still commits once its lock frees. */
export async function waitForAbandonedWrite(
  committed: () => Promise<boolean>,
  message: string
): Promise<void> {
  const done = await retryWithBackoff(committed, {
    maxRetries: 100,
    fixedDelays: Array.from({ length: 99 }, () => 100),
    isRetryable: () => false,
    shouldRetryResult: (observed) => !observed,
    component: 'AbandonedBrowserAuthWrite',
  });
  if (!done) throw new Error(message);
}
