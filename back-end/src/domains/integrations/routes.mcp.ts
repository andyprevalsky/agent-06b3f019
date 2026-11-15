/**
 * User MCP servers on the Integrations page.
 *
 *   GET    /                  list (status connected | needs_auth | failed, tool names)
 *   POST   /                  {url, name?, headers?, redirect_uri} → server [+ authorize_url]
 *   POST   /oauth/complete    {code, state} (the signed-in user's own session)
 *   POST   /:id/reconnect     {redirect_uri} → server [+ authorize_url]
 *   DELETE /:id
 *
 * redirect_uri must be a Rose web origin's /integrations/mcp/callback.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  completeMcpServerOAuth,
  connectMcpServer,
  deleteMcpServer,
  listMcpServers,
  McpServerError,
  reconnectMcpServer,
} from '../../providers/mcp/servers';
import { isGranolaRedirectOrigin } from './oauthService';

const BLOCKED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'cookie',
  'mcp-session-id',
  'mcp-protocol-version',
]);
const redirectSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      isGranolaRedirectOrigin(url.origin) &&
      url.pathname === '/integrations/mcp/callback' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}, 'redirect_uri is not an allowed Rose callback');
const connectSchema = z
  .object({
    url: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(80).optional(),
    headers: z
      .record(
        z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/)
          .refine((name) => !BLOCKED_HEADERS.has(name.toLowerCase()), 'header not allowed'),
        z.string().min(1).max(4096)
      )
      .refine((headers) => Object.keys(headers).length <= 8, 'at most 8 headers')
      .optional(),
    redirect_uri: redirectSchema,
  })
  .strict();
const completeSchema = z.object({ code: z.string().min(1), state: z.string().min(1) }).strict();
const reconnectSchema = z.object({ redirect_uri: redirectSchema }).strict();

function owner(req: AuthRequest, res: Response): string | null {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  if (typeof id !== 'string' || id === '') {
    res.status(401).json({ error: 'User not authenticated' });
    return null;
  }
  return id;
}

function handle(fn: (req: AuthRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<AuthRequest>(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = owner(req, res);
    if (userId === null) return;
    try {
      await fn(req, res, userId);
    } catch (error) {
      if (error instanceof McpServerError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      throw error;
    }
  });
}

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
  });
}

export function createMcpIntegrationRoutes(): Router {
  const router = Router();
  router.get(
    '/',
    authenticate,
    handle(async (_req, res, userId) => {
      res.json(await listMcpServers(userId));
    })
  );
  router.post(
    '/',
    authenticate,
    handle(async (req, res, userId) => {
      const parsed = connectSchema.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed.error);
      const { redirect_uri: redirectUri, ...input } = parsed.data;
      res.status(201).json(await connectMcpServer(userId, { ...input, redirectUri }));
    })
  );
  router.post(
    '/oauth/complete',
    authenticate,
    handle(async (req, res, userId) => {
      const parsed = completeSchema.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed.error);
      res.json(await completeMcpServerOAuth(userId, parsed.data.state, parsed.data.code));
    })
  );
  router.post(
    '/:id/reconnect',
    authenticate,
    handle(async (req, res, userId) => {
      const parsed = reconnectSchema.safeParse(req.body);
      if (!parsed.success) return invalid(res, parsed.error);
      res.json(await reconnectMcpServer(userId, String(req.params.id), parsed.data.redirect_uri));
    })
  );
  router.delete(
    '/:id',
    authenticate,
    handle(async (req, res, userId) => {
      await deleteMcpServer(userId, String(req.params.id));
      res.status(204).end();
    })
  );
  return router;
}
