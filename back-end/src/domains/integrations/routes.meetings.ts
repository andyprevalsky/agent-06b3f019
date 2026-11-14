/** Both meeting providers expose the same authenticated OAuth and sync routes. */
import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  MeetingSignInError,
  type createMeetingSync,
} from '../../services/integrations/meetingSync';
import { isGranolaRedirectOrigin } from './oauthService';

type MeetingService = ReturnType<typeof createMeetingSync>;
const log = createLogger('Integrations');
function userId(req: AuthRequest): string | undefined {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}
function allowedRedirect(value: unknown, provider: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      isGranolaRedirectOrigin(url.origin) &&
      url.pathname === `/integrations/${provider}/callback` &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
function startSync(service: MeetingService, id: string, provider: string): void {
  void service.syncUser(id).catch((error: unknown) =>
    log.error(`${provider} background sync crashed`, {
      userId: id,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}
function registerOAuth(router: Router, provider: string, service: MeetingService): void {
  router.post(
    `/${provider}/oauth/start`,
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = userId(req);
      if (id === undefined) return res.status(401).json({ error: 'User not authenticated' });
      const redirectUri = (req.body as { redirectUri?: unknown } | undefined)?.redirectUri;
      if (!allowedRedirect(redirectUri, provider))
        return res.status(400).json({ error: 'REDIRECT_URI_NOT_ALLOWED' });
      try {
        return res.json(await service.startSignIn(id, { redirectUri }));
      } catch (error) {
        log.warn(`${provider} sign-in start failed`, {
          userId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(502).json({ error: `${provider.toUpperCase()}_UNAVAILABLE` });
      }
    })
  );
  router.post(
    `/${provider}/oauth/complete`,
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const id = userId(req);
      if (id === undefined) return res.status(401).json({ error: 'User not authenticated' });
      const body = (req.body ?? {}) as { code?: unknown; state?: unknown };
      if (typeof body.code !== 'string' || body.code === '' || typeof body.state !== 'string')
        return res.status(400).json({ error: 'CODE_AND_STATE_REQUIRED' });
      try {
        await service.completeSignIn(id, body.state, body.code);
      } catch (error) {
        log.warn(`${provider} sign-in completion failed`, {
          userId: id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof MeetingSignInError)
          return res
            .status(error.code === 'EXCHANGE_FAILED' ? 502 : 400)
            .json({ error: error.code, message: error.message });
        throw error;
      }
      startSync(service, id, provider);
      return res.json(await service.getStatus(id));
    })
  );
}
export function createMeetingRoutes(provider: string, _label: string, service: MeetingService) {
  const router = Router();
  registerOAuth(router, provider, service);
  router.get(
    `/${provider}`,
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const id = userId(req);
      if (id === undefined) return res.status(401).json({ error: 'User not authenticated' });
      return res.json(await service.getStatus(id));
    })
  );
  router.post(
    `/${provider}/sync`,
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const id = userId(req);
      if (id === undefined) return res.status(401).json({ error: 'User not authenticated' });
      const status = await service.getStatus(id);
      if (!status.connected)
        return res.status(404).json({ error: `${provider.toUpperCase()}_NOT_CONNECTED` });
      startSync(service, id, provider);
      return res.status(202).json(status);
    })
  );
  router.delete(
    `/${provider}`,
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      const id = userId(req);
      if (id === undefined) return res.status(401).json({ error: 'User not authenticated' });
      return res.json(await service.disconnect(id));
    })
  );
  return router;
}
