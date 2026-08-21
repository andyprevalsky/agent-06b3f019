import { runTransactionWithRetry } from './database';
import { resumeAgentWorkflow } from './agentResume';
import { createMessage } from './messages';
import { createLogger } from './logger';
import { getTemporalClient } from './temporal';
import { DEPLOY_INTERRUPTED_TOOL_MESSAGE, lockAgentWorkflowGeneration } from './workflowGeneration';

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
      status: 'missing_steel_context';
      request: AuthAssistanceRequestRecord;
      workflowId: string;
    }
  | {
      status: 'already_completed';
      request: AuthAssistanceRequestRecord;
      /** True when the completed request belongs to a deploy-fenced generation. */
      interrupted: boolean;
      /**
       * True for a later client retry, which may safely retry signaling/resume.
       * False when this invocation lost the atomic completion claim and must
       * leave every post-transaction side effect to the winning invocation.
       */
      retrySideEffects: boolean;
      workflowId: string;
    }
  | {
      status: 'completed';
      request: AuthAssistanceRequestRecord;
      steelSessionAuthId: string | null;
      /**
       * True when the attention row was already terminal before this completion —
       * the deploy fence answered it with DEPLOY_INTERRUPTED. The credential is
       * still captured (it is the whole point of the user signing in), but the
       * fence marker is preserved and the dead generation is not signaled.
       */
      interrupted: boolean;
      workflowId: string;
    };

export interface AuthAssistanceCompletionDependencies {
  signalCompleted: typeof signalAuthAssistanceCompleted;
  resumeAgent: typeof resumeAgentWorkflow;
  /** Deterministic race seam for the completion-claim regression. */
  beforeCompletionClaim: () => Promise<void>;
}

export async function completeAuthAssistanceForUser(
  id: string,
  userId: string,
  now = new Date(),
  overrides: Partial<AuthAssistanceCompletionDependencies> = {}
): Promise<AuthAssistanceCompletionResult> {
  const deps: AuthAssistanceCompletionDependencies = {
    signalCompleted: signalAuthAssistanceCompleted,
    resumeAgent: resumeAgentWorkflow,
    beforeCompletionClaim: async () => undefined,
    ...overrides,
  };
  const result = await runTransactionWithRetry(async (tx) => {
    const request = await tx.userAuthAssistanceRequest.findUnique({
      where: { id },
      include: {
        attentionRequest: {
          select: { workflowId: true, userResponse: true },
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
        interrupted: request.attentionRequest.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
        retrySideEffects: true,
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

    await deps.beforeCompletionClaim();
    // Serialize the completion claim with deployment cleanup. Without the same
    // generation lock used by `finalizeInterruptedWorkflowTools`, completion can
    // claim `completedAt` while cleanup owns the agent and then race its attention
    // CAS, producing a committed credential whose resume path observed the wrong
    // generation boundary.
    await lockAgentWorkflowGeneration(tx, request.agentId);
    const completionClaim = await tx.userAuthAssistanceRequest.updateMany({
      where: { id, completedAt: null },
      data: { completedAt: now },
    });
    if (completionClaim.count === 0) {
      const persisted = await tx.userAuthAssistanceRequest.findUnique({
        where: { id },
        include: {
          attentionRequest: {
            select: { workflowId: true, userResponse: true },
          },
        },
      });
      if (persisted === null) return { status: 'not_found' as const };
      return {
        status: 'already_completed' as const,
        request: persisted,
        interrupted: persisted.attentionRequest.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
        retrySideEffects: false,
        workflowId: persisted.attentionRequest.workflowId,
      };
    }
    const completed = await tx.userAuthAssistanceRequest.findUniqueOrThrow({ where: { id } });
    // Compare-and-swap on the pending predicate, exactly like every other
    // resolver (`gateResolution.resolveAndSignal`). An unconditional write would
    // overwrite whatever already answered the row — in practice the deploy fence's
    // DEPLOY_INTERRUPTED marker, erasing the only record that the handoff died with
    // its workflow generation.
    const answered = await tx.agentAttentionRequest.updateMany({
      where: { id, userResponse: null },
      data: { userResponse: AUTH_ASSISTANCE_COMPLETED_RESPONSE },
    });
    const persistedAttention =
      answered.count === 0
        ? await tx.agentAttentionRequest.findUnique({
            where: { id },
            select: { userResponse: true },
          })
        : null;

    return {
      status: 'completed' as const,
      request: completed,
      steelSessionAuthId,
      interrupted:
        answered.count === 0 &&
        persistedAttention?.userResponse === DEPLOY_INTERRUPTED_TOOL_MESSAGE,
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
    if (result.interrupted) {
      // `workflowId` is the generation snapshotted when the request was raised.
      // It is terminated, and the replacement carries no `_signal_responses` entry
      // for this id, so the signal can only fail. Resume is still correct — the
      // surviving generation decides what to retry now that the credential exists.
      log.warn('Auth assistance completed after its workflow generation was fenced', {
        request_id: result.request.id,
        agent_id: result.request.agentId,
        workflow_id: result.workflowId,
      });
    } else {
      await deps.signalCompleted(result.workflowId, result.request.agentId, result.request.id);
    }
    try {
      await deps.resumeAgent(result.request.agentId);
    } catch (error) {
      // The completion transaction is already committed. Resume is retryable via
      // the already-completed path, so do not turn a successful credential capture
      // into a misleading 500 response.
      log.warn('Failed to resume completed auth assistance request', {
        request_id: result.request.id,
        agent_id: result.request.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.status === 'already_completed') {
    if (result.retrySideEffects) {
      if (result.interrupted) {
        log.warn('Skipped retry signal for deploy-fenced auth assistance request', {
          request_id: result.request.id,
          agent_id: result.request.agentId,
          workflow_id: result.workflowId,
        });
      } else {
        await deps.signalCompleted(result.workflowId, result.request.agentId, result.request.id);
      }
      try {
        await deps.resumeAgent(result.request.agentId);
      } catch (error) {
        log.warn('Failed to resume already-completed auth assistance request', {
          request_id: result.request.id,
          agent_id: result.request.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return result;
}
