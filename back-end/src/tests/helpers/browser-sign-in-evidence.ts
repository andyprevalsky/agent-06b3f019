import { createRequest } from '../../domains/auth-assistance/repo';
import type { AuthAssistanceMode } from '../../domains/auth-assistance/types';
import { completeAuthAssistanceForUser } from '../../providers/authAssistanceCompletion';
import { prisma } from '../../providers/database';

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
