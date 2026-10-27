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
 *
 * Auth: user JWT or hybrid API key (X-API-Key + X-User-Id). A project owned
 * by another user is indistinguishable from a missing one (404).
 */
import { Router, type NextFunction, type Response } from 'express';
import type { z } from 'zod';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import { runProjectStartupForOwner } from '../../providers/projects/workspace';
import { asyncHandler } from '../../utils/asyncHandler';
import * as envFiles from './envFileService';
import * as service from './service';
import * as sync from './syncService';
import {
  createEnvFileSchema,
  createProjectSchema,
  projectIdSchema,
  syncPushSchema,
  updateEnvFileSchema,
  updateProjectSchema,
  upsertProjectSchema,
} from './types';

const log = createLogger('ProjectsRoutes');
const router = Router();

function withHybridAuth(req: HybridAuthRequest, res: Response, next: NextFunction): void {
  void hybridAuth(req, res, next);
}

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

function idParam(req: HybridAuthRequest, res: Response, name = 'id'): string | null {
  const parsed = projectIdSchema.safeParse(req.params[name]);
  if (parsed.success) return parsed.data;
  res.status(404).json({ error: name === 'id' ? 'Project not found' : 'Not found' });
  return null;
}

/** Wrap a handler: resolve the caller, map ProjectError to its status. */
function handle(fn: (req: HybridAuthRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = requireUserId(req, res);
    if (userId === null) return;
    try {
      await fn(req, res, userId);
    } catch (err) {
      if (err instanceof service.ProjectError) {
        res
          .status(err.status)
          .json({ error: err.message, ...(err.code !== undefined ? { code: err.code } : {}) });
        return;
      }
      log.error('Project request failed', {
        path: req.path,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

router.use(withHybridAuth);

router.get(
  '/',
  handle(async (_req, res, userId) => {
    res.json(await service.listProjects(userId));
  })
);

router.post(
  '/',
  handle(async (req, res, userId) => {
    const body = parse(createProjectSchema, req.body, res);
    if (body !== null) res.status(201).json(await service.createProject(userId, body));
  })
);

router.put(
  '/',
  handle(async (req, res, userId) => {
    const body = parse(upsertProjectSchema, req.body, res);
    if (body === null) return;
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
