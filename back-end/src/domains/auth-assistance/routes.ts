import { NativePhoneAttentionError } from '../../providers/nativePhoneAttention';
import { parseNativeCreate } from './routes.native';
import type { AuthAssistanceCompletionDependencies } from '../../providers/authAssistanceCompletion';
import { Router, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  completeAuthAssistanceRequest,
  createAuthAssistanceRequest,
  getAuthAssistanceRequest,
  refreshAuthAssistanceSession,
} from './service';
import { AUTH_ASSISTANCE_MODES, type AuthAssistanceMode } from './types';
import { AttentionUserMessageForbiddenError } from '../../providers/attentionUserMessages';
import { AttentionWorkflowTargetOwnershipError } from '../../providers/attentionWorkflowTargets';

const log = createLogger('AuthAssistance');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapError(error: unknown, res: Response): boolean {
  if (error instanceof NativePhoneAttentionError) {
    res.status(error.status).json({ error: error.message });
    return true;
  }
  if (error instanceof BadRequestError) {
    res.status(400).json({ error: error.message });
    return true;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return true;
  }
  if (
    error instanceof ForbiddenError ||
    error instanceof AttentionUserMessageForbiddenError ||
    error instanceof AttentionWorkflowTargetOwnershipError
  ) {
    res.status(403).json({ error: error.message });
    return true;
  }
  return false;
}

function readString(
  body: Record<string, unknown>,
  camel: string,
  snake: string
): string | undefined {
  const value = body[camel] ?? body[snake];
  return typeof value === 'string' ? value : undefined;
}

function parseCreateBody(body: unknown) {
  if (typeof body !== 'object' || body === null) {
    throw new BadRequestError('Request body must be an object');
  }
  const record = body as Record<string, unknown>;
  if (record.targetKind === 'iphone') return parseNativeCreate(record);
  if (record.targetKind !== undefined && record.targetKind !== 'browser')
    throw new BadRequestError('Invalid assistance target kind');
  const agentId = readString(record, 'agentId', 'agent_id');
  const authRealm = readString(record, 'authRealm', 'auth_realm');
  const mode = readString(record, 'mode', 'mode');
  const browserSessionId = readString(record, 'browserSessionId', 'browser_session_id');
  const steelSessionId = readString(record, 'steelSessionId', 'steel_session_id');
  const browserUrl = readString(record, 'browserUrl', 'browser_url');
  const currentUrl = readString(record, 'currentUrl', 'current_url');

  if (agentId === undefined || agentId.trim() === '') {
    throw new BadRequestError('agentId is required');
  }
  if (authRealm === undefined || authRealm.trim() === '') {
    throw new BadRequestError('authRealm is required');
  }
  if (mode === undefined || !AUTH_ASSISTANCE_MODES.includes(mode as AuthAssistanceMode)) {
    throw new BadRequestError(`mode must be one of: ${AUTH_ASSISTANCE_MODES.join(', ')}`);
  }

  return {
    agentId,
    authRealm,
    mode: mode as AuthAssistanceMode,
    ...(browserSessionId !== undefined ? { browserSessionId } : {}),
    ...(steelSessionId !== undefined ? { steelSessionId } : {}),
    ...(browserUrl !== undefined ? { browserUrl } : {}),
    ...(currentUrl !== undefined ? { currentUrl } : {}),
  };
}

function requireUserId(req: HybridAuthRequest, res: Response): string | null {
  const userId = req.userId ?? req.user?.id;
  if (typeof userId !== 'string' || userId === '') {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return userId;
}

export function createAuthAssistanceRouter(
  options: { completionDependencies?: Partial<AuthAssistanceCompletionDependencies> } = {}
) {
  const router = Router();
  router.post(
    '/',
    asyncHandler(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      try {
        const userId = requireUserId(req, res);
        if (userId === null) return;
        const input = parseCreateBody(req.body);
        res.status(201).json(await createAuthAssistanceRequest(userId, input));
      } catch (error) {
        if (mapError(error, res)) return;
        log.error('Failed to create auth assistance request', { error: errMsg(error) });
        res.status(500).json({ error: 'Failed to create auth assistance request' });
      }
    })
  );

  router.get(
    '/:id',
    asyncHandler(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      try {
        const userId = requireUserId(req, res);
        if (userId === null) return;
        res.json(await getAuthAssistanceRequest(req.params.id, userId));
      } catch (error) {
        if (mapError(error, res)) return;
        log.error('Failed to fetch auth assistance request', { error: errMsg(error) });
        res.status(500).json({ error: 'Failed to fetch auth assistance request' });
      }
    })
  );

  router.post(
    '/:id/refresh-session',
    asyncHandler(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      try {
        const userId = requireUserId(req, res);
        if (userId === null) return;
        res.json(await refreshAuthAssistanceSession(req.params.id, userId));
      } catch (error) {
        if (mapError(error, res)) return;
        log.error('Failed to refresh auth assistance session', { error: errMsg(error) });
        res.status(500).json({ error: 'Failed to refresh auth assistance session' });
      }
    })
  );

  router.post(
    '/:id/complete',
    asyncHandler(hybridAuth),
    asyncHandler<HybridAuthRequest>(async (req, res) => {
      try {
        const userId = requireUserId(req, res);
        if (userId === null) return;
        res.json(
          await completeAuthAssistanceRequest(
            req.params.id,
            userId,
            req.body?.userMessage ?? req.body?.user_message,
            options.completionDependencies
          )
        );
      } catch (error) {
        if (mapError(error, res)) return;
        log.error('Failed to complete auth assistance request', { error: errMsg(error) });
        res.status(500).json({ error: 'Failed to complete auth assistance request' });
      }
    })
  );

  return router;
}
export default createAuthAssistanceRouter();
