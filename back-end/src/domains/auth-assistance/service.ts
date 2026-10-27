import { createNative, readNative } from './service.native';
import type { NativePhoneInput } from '../../providers/nativePhoneAttention';
import { canonicalAuthRealm } from '../../providers/authRealm';
import {
  completeAuthAssistanceForUser,
  type AuthAssistanceCompletionDependencies,
} from '../../providers/authAssistanceCompletion';
import { createLogger } from '../../providers/logger';
import { notifyAuthAssistance } from '../../providers/smsSupervisor/outboundEvents';
import { getBrowserSessionHealth } from '../../providers/browser';
import { resumeBrowserSession } from '../../providers/browserSessionResume';
import { getTilionLiveViewUrl, TilionUncarriedStateError } from '../../providers/browser/tilion';
import * as repo from './repo';
import type {
  AuthAssistanceHandoff,
  AuthAssistanceMode,
  CreateAuthAssistanceInput,
  SerializedAuthAssistanceRequest,
} from './types';

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class BadRequestError extends Error {}

const log = createLogger('AuthAssistance');

const REFRESH_TTL_BUFFER_MS = 60_000;

function serializeRequest(request: {
  id: string;
  agentId: string;
  userId: string;
  authRealm: string;
  browserSessionId: string | null;
  steelSessionId: string;
  mode: string;
  createdAt: Date;
  completedAt: Date | null;
}): SerializedAuthAssistanceRequest {
  return {
    id: request.id,
    agentId: request.agentId,
    userId: request.userId,
    authRealm: request.authRealm,
    browserSessionId: request.browserSessionId ?? null,
    steelSessionId: request.steelSessionId,
    mode: request.mode,
    createdAt: request.createdAt.toISOString(),
    completedAt: request.completedAt?.toISOString() ?? null,
  };
}

function interactiveDebugUrl(debugUrl: string | null | undefined): string | null {
  if (debugUrl === null || debugUrl === undefined || debugUrl === '') return null;
  try {
    const url = new URL(debugUrl);
    url.searchParams.delete('readOnly');
    url.searchParams.set('interactive', 'true');
    url.searchParams.set('showControls', 'true');
    return url.toString();
  } catch {
    const separator = debugUrl.includes('?') ? '&' : '?';
    return `${debugUrl}${separator}interactive=true&showControls=true`;
  }
}

function handoffForMode(
  mode: AuthAssistanceMode,
  steelSessionId: string,
  debugUrl: string | null | undefined
): AuthAssistanceHandoff {
  return {
    type: mode,
    steelSessionId: steelSessionId === '' ? null : steelSessionId,
    liveViewUrl: mode === 'live_view' ? interactiveDebugUrl(debugUrl) : null,
  };
}

function isLiveBrowserStatus(status: string | null): boolean {
  if (status === null) return false;
  return ['live', 'active', 'running'].includes(status.toLowerCase());
}

export async function createAuthAssistanceRequest(
  userId: string,
  input: CreateAuthAssistanceInput
) {
  if (input.targetKind === 'iphone') return createNative(userId, input as NativePhoneInput);
  const agent = await repo.findAgentForUser(input.agentId, userId);
  if (agent === null) throw new NotFoundError('Agent not found');

  const authRealm = canonicalAuthRealm(input.authRealm);
  if (authRealm === '') throw new BadRequestError('authRealm is required');

  const session =
    input.browserSessionId !== undefined && input.browserSessionId !== ''
      ? await repo.findSessionByBrowserSessionId(input.browserSessionId, userId)
      : input.steelSessionId !== undefined && input.steelSessionId !== ''
        ? await repo.findSessionBySteelSessionId(input.steelSessionId, userId)
        : await repo.findLatestSessionForAgent(input.agentId, userId);

  if (input.browserSessionId !== undefined && input.browserSessionId !== '' && session === null) {
    throw new BadRequestError('browserSessionId does not belong to this user');
  }
  if (
    input.browserSessionId === undefined &&
    input.steelSessionId !== undefined &&
    input.steelSessionId !== '' &&
    session === null
  ) {
    throw new BadRequestError('steelSessionId does not belong to this user');
  }

  const browserSessionId = session?.id ?? input.browserSessionId ?? null;
  const steelSessionId = session?.sessionId ?? input.steelSessionId ?? '';
  if (input.mode === 'live_view' && steelSessionId === '') {
    throw new BadRequestError('A browser session is required for live_view assistance');
  }

  // Tilion view tokens are minted here, never taken from the worker: it sends a
  // redacted browserUrl, and the stored debugUrl expires after 1800 s.
  const tilionViewUrl =
    session?.provider === 'tilion' && session.sessionId !== null
      ? await getTilionLiveViewUrl(session.sessionId)
      : undefined;
  const handoff = handoffForMode(input.mode, steelSessionId, tilionViewUrl ?? session?.debugUrl);
  const request = await repo.createRequest({
    ...input,
    ...(tilionViewUrl !== undefined ? { browserUrl: tilionViewUrl } : {}),
    userId,
    authRealm,
    ...(browserSessionId !== null ? { browserSessionId } : {}),
    steelSessionId,
    workflowId: agent.temporalWorkflowId ?? agent.id,
    liveViewUrl: handoff.liveViewUrl,
  });

  if (agent.source === 'SMS') {
    try {
      await notifyAuthAssistance(userId, { id: agent.id }, authRealm, browserSessionId);
    } catch (error) {
      log.warn('Failed to send auth assistance SMS notification', {
        agent_id: agent.id,
        auth_realm: authRealm,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    request: serializeRequest(request),
    handoff,
  };
}

export async function getAuthAssistanceRequest(id: string, userId: string) {
  const native = await readNative(id, userId);
  if (native !== null) return native;
  const request = await repo.findRequestById(id);
  if (request === null) throw new NotFoundError('Auth assistance request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not authorized');

  const session =
    request.browserSessionId !== null
      ? await repo.findSessionByBrowserSessionId(request.browserSessionId, userId)
      : request.steelSessionId === ''
        ? null
        : await repo.findSessionBySteelSessionId(request.steelSessionId, userId);
  const liveSteelSessionId = session?.sessionId ?? request.steelSessionId;

  return {
    request: serializeRequest(request),
    handoff: handoffForMode(
      request.mode as AuthAssistanceMode,
      liveSteelSessionId,
      session?.debugUrl
    ),
  };
}

/** Hand off the still-live session; Tilion view tokens expire after 1800 s, so mint a fresh URL. */
async function liveSameSessionHandoff(
  request: Parameters<typeof serializeRequest>[0],
  session: { sessionId: string; provider: string; debugUrl: string | null }
) {
  const debugUrl =
    session.provider === 'tilion'
      ? await getTilionLiveViewUrl(session.sessionId)
      : session.debugUrl;
  return {
    request: serializeRequest(request),
    handoff: handoffForMode('live_view', session.sessionId, debugUrl),
    liveViewUrl: interactiveDebugUrl(debugUrl),
    refreshed: false,
    alreadyCompleted: false,
  };
}

/** A completed or non-live-view request has no browser to refresh: echo its handoff. */
function unrefreshedHandoff(
  request: NonNullable<Awaited<ReturnType<typeof repo.findRequestById>>>
) {
  if (request.completedAt === null && request.mode === 'live_view') return null;
  return {
    request: serializeRequest(request),
    handoff: handoffForMode(request.mode as AuthAssistanceMode, request.steelSessionId, null),
    refreshed: false,
    alreadyCompleted: request.completedAt !== null,
  };
}

export async function refreshAuthAssistanceSession(id: string, userId: string) {
  const native = await readNative(id, userId, true);
  if (native !== null) return native;
  const request = await repo.findRequestById(id);
  if (request === null) throw new NotFoundError('Auth assistance request not found');
  if (request.userId !== userId) throw new ForbiddenError('Not authorized');
  const unrefreshed = unrefreshedHandoff(request);
  if (unrefreshed !== null) return unrefreshed;

  const session =
    request.browserSessionId !== null
      ? await repo.findSessionByBrowserSessionId(request.browserSessionId, userId)
      : await repo.findSessionBySteelSessionId(request.steelSessionId, userId);
  if (session === null)
    throw new BadRequestError('Browser context is not available for this request');
  const liveSteelSessionId = session.sessionId;

  if (liveSteelSessionId?.startsWith('local-') === true) {
    const liveViewUrl = interactiveDebugUrl(session.debugUrl);
    return {
      request: serializeRequest(request),
      handoff: handoffForMode('live_view', liveSteelSessionId, session.debugUrl),
      liveViewUrl,
      refreshed: false,
      alreadyCompleted: false,
    };
  }

  /* c8 ignore start -- non-local Steel health/resume path requires Steel SDK/session */
  let sameSessionAvailable = session.status === 'ACTIVE' && liveSteelSessionId !== null;
  if (sameSessionAvailable && liveSteelSessionId !== null) {
    try {
      const health = await getBrowserSessionHealth(liveSteelSessionId);
      const hasEnoughTtl = health.ttlMs === null || health.ttlMs > REFRESH_TTL_BUFFER_MS;
      sameSessionAvailable = isLiveBrowserStatus(health.status) && hasEnoughTtl;
    } catch (error) {
      sameSessionAvailable = false;
      log.warn('Browser session refresh health check failed', {
        request_id: id,
        session_id: liveSteelSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // sessionId is null for a logical browser that never materialized a provider session.
  const sameSessionHandoff = (sessionId: string) =>
    liveSameSessionHandoff(request, { ...session, sessionId });
  if (sameSessionAvailable && liveSteelSessionId !== null) {
    return sameSessionHandoff(liveSteelSessionId);
  }

  let resumed: Awaited<ReturnType<typeof resumeBrowserSession>>;
  try {
    resumed = await resumeBrowserSession(session.id);
  } catch (error) {
    // A live (only expiring) Tilion browser holds state only the worker can
    // capture; replacing it here would lose that state, so hand off the same one.
    if (error instanceof TilionUncarriedStateError && liveSteelSessionId !== null) {
      return sameSessionHandoff(liveSteelSessionId);
    }
    throw error;
  }
  const liveViewUrl = interactiveDebugUrl(resumed.debug_url);
  const updatedRequest = await repo.updateLiveViewHandoff(
    id,
    session.id,
    resumed.session_id,
    liveViewUrl
  );

  return {
    request: serializeRequest(updatedRequest),
    handoff: handoffForMode('live_view', resumed.session_id, resumed.debug_url),
    liveViewUrl,
    refreshed: true,
    alreadyCompleted: false,
  };
  /* c8 ignore stop */
}

export async function completeAuthAssistanceRequest(
  id: string,
  userId: string,
  userMessage?: string,
  dependencies?: Partial<AuthAssistanceCompletionDependencies>
) {
  const result = await completeAuthAssistanceForUser(
    id,
    userId,
    new Date(),
    dependencies,
    userMessage
  );

  if (result.status === 'not_found') throw new NotFoundError('Auth assistance request not found');
  if (result.status === 'forbidden') throw new ForbiddenError('Not authorized');
  if (result.status === 'missing_steel_context') {
    throw new BadRequestError('Browser context is not available for this live_view request');
  }

  return {
    request: (await readNative(id, userId))?.request ?? serializeRequest(result.request),
    completed: true,
    alreadyCompleted: result.status === 'already_completed',
  };
}
