/**
 * /api/projects — owner-scoped Projects (settings, env files, codebase sync).
 *
 *   GET    /api/projects                        list (with env-file counts)
 *   POST   /api/projects                        create
 *   PUT    /api/projects                        upsert by name (rose-sync, seeds)
 *   GET    /api/projects/sync-key               public key for client-side encryption
 *   GET    /api/projects/:id                    one project
 *   PUT    /api/projects/:id                    update settings
 *   DELETE /api/projects/:id                    delete (agents fall back to Home)
 *   GET    /api/projects/:id/env-files[?q=]     list / search (never values)
 *   POST   /api/projects/:id/env-files          add (values encrypted at rest)
 *   PUT    /api/projects/:id/env-files/:fileId  edit values / description / path
 *   DELETE /api/projects/:id/env-files/:fileId  remove
 *   GET    /api/projects/:id/sync               revision, salt, fingerprints
 *   POST   /api/projects/:id/sync               push an encrypted checkout snapshot
 *   POST   /api/projects/:id/sessions/:sessionId/startup  re-run the startup script
 *   POST   /api/projects/cli-login-codes        mint a one-time CLI login code (user session)
 *   POST   /api/projects/cli-login-codes/exchange  CLI trades the code once (no auth;
 *                                               10 failed attempts per address per 15 min
 *                                               then 429) for a rose_cli_ credential
 *   GET    /api/projects/:id/maintenance        template snapshot, schedule, recent runs
 *   POST   /api/projects/:id/maintenance/runs   Run now {mode: sync} / Snapshot now {mode: snapshot}
 *   GET    /api/projects/:id/maintenance/runs/:runId  one run with its (redacted) log
 *
 * Auth: user JWT, hybrid API key (X-API-Key + X-User-Id), or a CLI credential
 * (`Authorization: Bearer rose_cli_…`, cliLoginService.ts). A CLI credential
 * works only on this router; one bound to a project sees only that project,
 * and no CLI credential can mint codes, create a second project when bound,
 * or delete a project. A project owned by another user (or outside a CLI
 * credential's project) is indistinguishable from a missing one (404).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { z } from 'zod';
import { requireCredentialMintSession } from '../../providers/credentialMintAuth';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { runProjectStartupForOwner } from '../../providers/projects/workspace';
import { asyncHandler } from '../../utils/asyncHandler';
import * as cliLogin from './cliLoginService';
import * as envFiles from './envFileService';
import { registerMaintenanceRoutes } from './routes.maintenance';
import * as service from './service';
import * as sync from './syncService';
import {
  createEnvFileSchema,
  createProjectSchema,
  exchangeCliLoginCodeSchema,
  mintCliLoginCodeSchema,
  projectIdSchema,
  syncPushSchema,
  updateEnvFileSchema,
  updateProjectSchema,
  upsertProjectSchema,
} from './types';

const log = createLogger('ProjectsRoutes');
const router = Router();

type ProjectsRequest = HybridAuthRequest & { cliScope?: cliLogin.CliCredentialScope };

/** A `Bearer rose_cli_…` credential is resolved here; anything else goes to hybridAuth. */
function withProjectsAuth(req: ProjectsRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!cliLogin.isCliCredential(token)) {
    void hybridAuth(req, res, next);
    return;
  }
  cliLogin
    .verifyCliCredential(token)
    .then((scope) => {
      if (scope === null) {
        res.status(401).json({
          error: 'Rose CLI login expired or revoked. Copy a fresh setup prompt from Rose.',
          code: 'cli_credential_invalid',
        });
        return;
      }
      req.userId = scope.userId;
      req.cliScope = scope;
      next();
    })
    .catch(next);
}

/** Client address for the exchange limiter: the hop our proxy appended, else the socket. */
function clientAddress(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return chain.at(-1) ?? req.socket.remoteAddress ?? 'unknown';
}

const exchangeLimiter = new cliLogin.ExchangeRateLimiter();

function requireUserId(req: HybridAuthRequest, res: Response): string | null {
  if (typeof req.userId === 'string' && req.userId.length > 0) return req.userId;
  res.status(400).json({ error: 'X-User-Id (or user_id) is required for API-key calls' });
  return null;
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response): z.infer<S> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data as z.infer<S>;
  res.status(400).json({
    error: 'Invalid body',
    details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  return null;
}

function idParam(req: ProjectsRequest, res: Response, name = 'id'): string | null {
  const parsed = projectIdSchema.safeParse(req.params[name]);
  const boundProjectId = req.cliScope?.projectId ?? null;
  const outOfScope =
    parsed.success && name === 'id' && boundProjectId !== null && parsed.data !== boundProjectId;
  if (parsed.success && !outOfScope) return parsed.data;
  res.status(404).json({ error: name === 'id' ? 'Project not found' : 'Not found' });
  return null;
}

function cliForbidden(res: Response, error: string): void {
  res.status(403).json({ error, code: 'cli_scope' });
}

function sendProjectError(res: Response, err: unknown): boolean {
  if (!(err instanceof service.ProjectError)) return false;
  res
    .status(err.status)
    .json({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
  return true;
}

/** Wrap a handler: resolve the caller, map ProjectError to its status. */
function handle(fn: (req: ProjectsRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<ProjectsRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    try {
      await fn(req, res, userId);
    } catch (err) {
      if (sendProjectError(res, err)) return;
      log.error('Project request failed', {
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

// Unauthenticated: the code is the credential. Mounted before the auth middleware.
router.post(
  '/cli-login-codes/exchange',
  asyncHandler(async (req, res) => {
    const address = clientAddress(req);
    const verdict = exchangeLimiter.check(address);
    if (!verdict.allowed) {
      res.setHeader('Retry-After', String(verdict.retryAfterS));
      res.status(429).json({
        error: 'Too many failed login attempts. Wait and copy a fresh prompt from Rose.',
        code: 'rate_limited',
      });
      return;
    }
    const body = parse(exchangeCliLoginCodeSchema, req.body, res);
    if (body === null) {
      exchangeLimiter.recordFailure(address);
      return;
    }
    try {
      res.json(await cliLogin.exchangeCliLoginCode(body.code));
    } catch (err) {
      exchangeLimiter.recordFailure(address);
      if (!sendProjectError(res, err)) throw err;
    }
  })
);

router.use(withProjectsAuth);

router.post(
  '/cli-login-codes',
  (req: ProjectsRequest, res: Response, next: NextFunction) => {
    // Only a signed-in user session mints codes: not API keys, not CLI credentials.
    if (req.user === undefined || req.cliScope !== undefined) {
      res.status(403).json({
        error: 'Sign in to Rose to create a CLI login code',
        code: 'USER_SESSION_REQUIRED',
      });
      return;
    }
    next();
  },
  requireCredentialMintSession,
  handle(async (req, res, userId) => {
    const body = parse(mintCliLoginCodeSchema, req.body ?? {}, res);
    if (body !== null)
      res.status(201).json(await cliLogin.mintCliLoginCode(userId, body.projectId));
  })
);

router.get(
  '/',
  handle(async (req, res, userId) => {
    const result = await service.listProjects(userId);
    const bound = req.cliScope?.projectId ?? null;
    res.json(bound === null ? result : { projects: result.projects.filter((p) => p.id === bound) });
  })
);

router.post(
  '/',
  handle(async (req, res, userId) => {
    if ((req.cliScope?.projectId ?? null) !== null) {
      cliForbidden(res, 'This Rose CLI login is limited to one project');
      return;
    }
    const body = parse(createProjectSchema, req.body, res);
    if (body !== null) res.status(201).json(await service.createProject(userId, body));
  })
);

router.put(
  '/',
  handle(async (req, res, userId) => {
    const body = parse(upsertProjectSchema, req.body, res);
    if (body === null) return;
    const bound = req.cliScope?.projectId ?? null;
    if (bound !== null && (await service.requireProject(userId, bound)).name !== body.name) {
      cliForbidden(res, 'This Rose CLI login is limited to one project');
      return;
    }
    const result = await service.upsertProjectByName(userId, body);
    res.status(result.created ? 201 : 200).json(result.project);
  })
);

router.get(
  '/sync-key',
  handle(async (_req, res) => {
    res.json(sync.getSyncKey());
  })
);

router.get(
  '/:id',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    if (id !== null) res.json(await service.getProject(userId, id));
  })
);

router.put(
  '/:id',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const body = id !== null ? parse(updateProjectSchema, req.body, res) : null;
    if (id !== null && body !== null) res.json(await service.updateProject(userId, id, body));
  })
);

router.delete(
  '/:id',
  handle(async (req, res, userId) => {
    if (req.cliScope !== undefined) {
      cliForbidden(res, 'Delete projects from Rose, not with the CLI');
      return;
    }
    const id = idParam(req, res);
    if (id === null) return;
    await service.deleteProject(userId, id);
    res.status(204).end();
  })
);

router.get(
  '/:id/env-files',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    if (id !== null) res.json(await envFiles.listEnvFiles(userId, id, q));
  })
);

router.post(
  '/:id/env-files',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const body = id !== null ? parse(createEnvFileSchema, req.body, res) : null;
    if (id !== null && body !== null)
      res.status(201).json(await envFiles.createEnvFile(userId, id, body));
  })
);

router.put(
  '/:id/env-files/:fileId',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const fileId = id !== null ? idParam(req, res, 'fileId') : null;
    const body = fileId !== null ? parse(updateEnvFileSchema, req.body, res) : null;
    if (id !== null && fileId !== null && body !== null)
      res.json(await envFiles.updateEnvFile(userId, id, fileId, body));
  })
);

router.delete(
  '/:id/env-files/:fileId',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const fileId = id !== null ? idParam(req, res, 'fileId') : null;
    if (id === null || fileId === null) return;
    await envFiles.deleteEnvFile(userId, id, fileId);
    res.status(204).end();
  })
);

router.get(
  '/:id/sync',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    if (id !== null) res.json(await sync.getSyncState(userId, id));
  })
);

router.post(
  '/:id/sync',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const body = id !== null ? parse(syncPushSchema, req.body, res) : null;
    if (id !== null && body !== null) res.json(await sync.applySyncPush(userId, id, body));
  })
);

registerMaintenanceRoutes(router, { handle, idParam, parse });

router.post(
  '/:id/sessions/:sessionId/startup',
  handle(async (req, res, userId) => {
    const id = idParam(req, res);
    const sessionId = id !== null ? idParam(req, res, 'sessionId') : null;
    if (id === null || sessionId === null) return;
    await service.requireProject(userId, id);
    const report = await runProjectStartupForOwner(sessionId, userId, id);
    if (report === null) {
      res.status(404).json({ error: 'No restored workspace for this session' });
      return;
    }
    res.json(report);
  })
);

export default router;
