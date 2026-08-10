import { runTransactionWithRetry } from './database';
import { resumeAgentWorkflow } from './agentResume';
import { createMessage } from './messages';
import { createLogger } from './logger';
import { getTemporalClient } from './temporal';

export const AUTH_ASSISTANCE_COMPLETED_RESPONSE = '__AUTH_ASSISTANCE_COMPLETED__';

const log = createLogger('AuthAssistanceCompletion');

type AuthAssistanceRequestRecord = {
  id: string;
  agentId: string;
  userId: string;
  authRealm: string;
  browserSessionId: string | null;
  steelSessionId: string;
  mode: string;
  createdAt: Date;
  completedAt: Date | null;
};

async function signalAuthAssistanceCompleted(
  workflowId: string,
  agentId: string,
  requestId: string
): Promise<void> {
  try {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(workflowId);
    await handle.signal(
      'receive_user_response',
      JSON.stringify({
        request_id: requestId,
        response: AUTH_ASSISTANCE_COMPLETED_RESPONSE,
      })
    );
  } catch (error) {
    log.warn('Failed to signal auth assistance completion response', {
      request_id: requestId,
      agent_id: agentId,
      workflow_id: workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type AuthAssistanceCompletionResult =
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | {
      status: 'missing_steel_context' | 'already_completed';
      request: AuthAssistanceRequestRecord;
      workflowId: string;
    }
  | {
      status: 'completed';
      request: AuthAssistanceRequestRecord;
      steelSessionAuthId: string | null;
      workflowId: string;
    };

export async function completeAuthAssistanceForUser(
  id: string,
  userId: string,
  now = new Date()
): Promise<AuthAssistanceCompletionResult> {
  const result = await runTransactionWithRetry(async (tx) => {
    const request = await tx.userAuthAssistanceRequest.findUnique({
      where: { id },
      include: {
        attentionRequest: {
          select: { workflowId: true },
        },
      },
    });

    if (request === null) {
      return { status: 'not_found' as const };
    }
    if (request.userId !== userId) {
      return { status: 'forbidden' as const };
    }
    if (request.completedAt !== null) {
      return {
        status: 'already_completed' as const,
        request,
        workflowId: request.attentionRequest.workflowId,
      };
    }

    let steelSessionAuthId: string | null = null;

    if (request.mode === 'live_view') {
      const session = await tx.browserSession.findFirst({
        where: {
          ...(request.browserSessionId !== null
            ? { id: request.browserSessionId }
            : { sessionId: request.steelSessionId }),
          context: { userId },
        },
        include: { context: true },
      });
      if (session === null || session === undefined) {
        return {
          status: 'missing_steel_context' as const,
          request,
          workflowId: request.attentionRequest.workflowId,
        };
      }

      if (session.provider === 'steel') {
        const steelContextId = session.providerProfileId;
        if (typeof steelContextId !== 'string' || steelContextId === '') {
          return {
            status: 'missing_steel_context' as const,
            request,
            workflowId: request.attentionRequest.workflowId,
          };
        }

        const steelAuth = await tx.steelSessionAuth.upsert({
          where: {
            userId_contextId_authRealm: {
              userId,
              contextId: steelContextId,
              authRealm: request.authRealm,
            },
          },
          create: {
            userId,
            contextId: steelContextId,
            authRealm: request.authRealm,
            authenticatedAt: now,
            disabledAt: null,
            disabledReason: null,
          },
          update: {
            authenticatedAt: now,
            disabledAt: null,
            disabledReason: null,
          },
        });
        // Release this Steel context from any OTHER row before claiming it.
        // `BrowserContext.contextId` is @unique and BrowserProviderProfile has
        // @@unique([provider, profileId]), so a stale binding elsewhere makes
        // the next two writes throw — and that rolls the whole transaction
        // back, discarding a sign-in the user actually completed.
        await tx.browserContext.updateMany({
          where: { contextId: steelContextId, id: { not: session.context.id } },
          data: { contextId: null },
        });
        await tx.browserProviderProfile.deleteMany({
          where: {
            provider: 'steel',
            profileId: steelContextId,
            contextId: { not: session.context.id },
          },
        });
        await tx.browserContext.update({
          where: { id: session.context.id },
          data: { contextId: steelContextId },
        });
        await tx.browserProviderProfile.upsert({
          where: {
            contextId_provider: {
              contextId: session.context.id,
              provider: 'steel',
            },
          },
          create: {
            contextId: session.context.id,
            provider: 'steel',
            profileId: steelContextId,
          },
          update: { profileId: steelContextId },
        });
        await tx.browserSession.update({
          where: { id: session.id },
          data: {
            providerProfileSource: 'steel_session_auth',
            providerProfilePersist: true,
          },
        });
        steelSessionAuthId = steelAuth.id;
      } else if (session.provider !== 'kernel') {
        return {
          status: 'missing_steel_context' as const,
          request,
          workflowId: request.attentionRequest.workflowId,
        };
      }
    }

    const completed = await tx.userAuthAssistanceRequest.update({
      where: { id },
      data: { completedAt: now },
    });
    await tx.agentAttentionRequest.update({
      where: { id },
      data: { userResponse: AUTH_ASSISTANCE_COMPLETED_RESPONSE },
    });

    return {
      status: 'completed' as const,
      request: completed,
      steelSessionAuthId,
      workflowId: request.attentionRequest.workflowId,
    };
  });

  if (result.status === 'completed') {
    if (result.steelSessionAuthId !== null) {
      try {
        await createMessage({
          agentId: result.request.agentId,
          role: 'SYSTEM',
          text: `User completed authentication for ${result.request.authRealm}`,
          metadata: {
            credential_ref: { kind: 'steel_session', id: result.steelSessionAuthId },
            auth_realm: result.request.authRealm,
            action_type: 'auth_assistance_completed',
          },
        });
      } catch (error) {
        log.warn('Failed to log auth assistance credential reference', {
          request_id: result.request.id,
          agent_id: result.request.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await signalAuthAssistanceCompleted(
      result.workflowId,
      result.request.agentId,
      result.request.id
    );
    await resumeAgentWorkflow(result.request.agentId);
  }

  if (result.status === 'already_completed') {
    await signalAuthAssistanceCompleted(
      result.workflowId,
      result.request.agentId,
      result.request.id
    );
    try {
      await resumeAgentWorkflow(result.request.agentId);
    } catch (error) {
      log.warn('Failed to resume already-completed auth assistance request', {
        request_id: result.request.id,
        agent_id: result.request.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
