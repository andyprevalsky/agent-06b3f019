/**
 * AgentCard "for companies" routes.
 *
 *  Public (browser-tappable) OAuth surface:
 *    GET  /api/agentcard/connect?user=<id>   -> 302 to AgentCard /authorize
 *    GET  /api/agentcard/callback            -> exchanges code, stores token
 *
 *  Agent/app surface (internal API key or JWT):
 *    GET  /api/agentcard/status              -> { connected, expiresAt }
 *    GET  /api/agentcard/tools               -> live toolset OR a connect link
 *    POST /api/agentcard/tools/call          -> run any advertised tool
 *
 * The /tools + /tools/call routes ARE the brain-facing seam: the agent looks up
 * the user's token; if none, it hands the user the returned `connectUrl`; if
 * present it receives the FULL live toolset and may call any tool in a loop.
 */

import { Router, urlencoded, type Request, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  AgentCardOAuthError,
  connectUrlForUser,
  verifyConnectToken,
} from '../../providers/agentcard/config';
import {
  AgentCardNotConnectedError,
  callUserTool,
  listUserTools,
} from '../../providers/agentcard/runtime';
import * as service from './service';
import { handleV2Request } from './v2-routes';
import type { V2OnboardingDependencies } from '../../providers/agentcard/v2-onboarding';

export function createV2Router(dependencies: Partial<V2OnboardingDependencies> = {}): Router {
  const v2 = Router();
  v2.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });
  v2.use(urlencoded({ extended: false, limit: '4kb' }));
  for (const [path, action] of [
    ['/connect', 'show'],
    ['/connect/start', 'start'],
    ['/connect/verify', 'verify'],
  ] as const) {
    v2[action === 'show' ? 'get' : 'post'](
      path,
      asyncHandler(async (req, res) => {
        const result = await handleV2Request(
          action,
          (action === 'show' ? req.query : (req.body ?? {})) as Record<string, unknown>,
          dependencies
        );
        res.status(result.status);
        if (result.html !== undefined) res.type('html').send(result.html);
        else res.json({ error: result.error });
      })
    );
  }
  return v2;
}

const log = createLogger('AgentCard');
const router = Router();
router.use('/v2', createV2Router());

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function resultPage(res: Response, opts: { success: boolean; message: string }): void {
  const color = opts.success ? '#16a34a' : '#dc2626';
  res.status(opts.success ? 200 : 400).type('html').send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>AgentCard ${escapeHtml(opts.success ? 'Connected' : 'Error')}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; text-align: center; }
      .status { font-size: 18px; color: ${color}; }
    </style>
  </head>
  <body>
    <p class="status">${escapeHtml(opts.message)}</p>
    <script>setTimeout(() => window.close(), 1500);</script>
  </body>
</html>`);
}

// GET /connect?user=<id>&t=<signed-token>
router.get(
  '/connect',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = typeof req.query.user === 'string' ? req.query.user.trim() : '';
    const token = typeof req.query.t === 'string' ? req.query.t.trim() : '';
    if (userId === '') {
      res.status(400).json({ error: 'Missing required query param: user' });
      return;
    }
    // The user param is untrusted on this unauthenticated GET, so require the
    // short-lived signature we minted in `connectUrlForUser`. This blocks
    // linking a financial account to an arbitrary user id.
    if (token === '' || !verifyConnectToken(userId, token)) {
      res.status(400).json({ error: 'Invalid or expired connection link' });
      return;
    }
    const { authUrl } = await service.startConnect(userId);
    res.redirect(302, authUrl);
  })
);

// GET /callback?code&state
router.get(
  '/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const { code, state, error } = req.query;
    if (typeof error === 'string' && error !== '') {
      log.warn('AgentCard callback returned error', { error });
      resultPage(res, { success: false, message: `Authorization failed: ${error}` });
      return;
    }
    if (typeof code !== 'string' || typeof state !== 'string') {
      resultPage(res, { success: false, message: 'Missing authorization code or state' });
      return;
    }
    try {
      await service.handleCallback(code, state);
      resultPage(res, {
        success: true,
        message: 'AgentCard connected. You can close this window.',
      });
    } catch (err) {
      log.error('AgentCard callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      resultPage(res, {
        success: false,
        message: 'Failed to connect AgentCard. Please try again.',
      });
    }
  })
);

// GET /onboarding/callback?session_id&state
router.get(
  '/onboarding/callback',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
    const userId = typeof req.query.state === 'string' ? req.query.state.trim() : '';
    if (sessionId === '' || userId === '') {
      resultPage(res, { success: false, message: 'Missing onboarding session or state' });
      return;
    }
    try {
      await service.handleOnboardingCallback(userId, sessionId);
      resultPage(res, {
        success: true,
        message: 'Agent payment setup complete. Rose will continue automatically.',
      });
    } catch (err) {
      log.error('AgentCard onboarding callback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      resultPage(res, {
        success: false,
        message: 'Agent payment setup is not complete yet. Please finish the setup flow.',
      });
    }
  })
);

function requireUserId(req: HybridAuthRequest, res: Response): string | undefined {
  const userId = req.userId;
  if (userId === undefined || userId === '') {
    res.status(401).json({ error: 'Authenticated user required' });
    return undefined;
  }
  return userId;
}

// GET /status
router.get(
  '/status',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === undefined) return;
    res.json(await service.getStatus(userId));
  })
);

// GET /tools — the full live toolset, or a connect link if not connected.
router.get(
  '/tools',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === undefined) return;
    try {
      const tools = await listUserTools(userId);
      res.json({ connected: true, tools });
    } catch (err) {
      if (err instanceof AgentCardNotConnectedError) {
        res.json({ connected: false, connectUrl: connectUrlForUser(userId) });
        return;
      }
      throw err;
    }
  })
);

// POST /tools/call { name, arguments }
router.post(
  '/tools/call',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === undefined) return;
    const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }
    const args =
      typeof body.arguments === 'object' && body.arguments !== null
        ? (body.arguments as Record<string, unknown>)
        : {};
    try {
      const result = await callUserTool(userId, name, args);
      res.json({ result });
    } catch (err) {
      if (err instanceof AgentCardNotConnectedError) {
        res.status(409).json({ connected: false, connectUrl: connectUrlForUser(userId) });
        return;
      }
      if (err instanceof AgentCardOAuthError) {
        res.status(502).json({ error: err.message });
        return;
      }
      throw err;
    }
  })
);

export default router;
