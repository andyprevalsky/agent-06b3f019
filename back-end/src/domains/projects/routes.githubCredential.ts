/**
 * The caller's own GitHub credential, mounted at /api/projects/github-credential
 * (server.ts, ahead of the projects router) behind the same projects auth
 * (user session, API key + X-User-Id, or a `rose_cli_` login):
 *
 *   GET    /api/projects/github-credential[?repo=URL]  status; with `repo`, whether Rose can reach it
 *   PUT    /api/projects/github-credential             {keyId, encryptedToken} (project sync envelope)
 *   DELETE /api/projects/github-credential             remove it (not from a CLI login)
 *
 * The credential is the caller's alone: no route reads another user's, and no
 * response carries the token or its envelope.
 */
import { Router, type Response } from 'express';
import { z } from 'zod';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as credential from './githubCredentialService';
import { withProjectsAuth, type ProjectsRequest } from './routes';
import { ProjectError } from './service';

const log = createLogger('GithubCredentialRoutes');
const router = Router();

const importSchema = z
  .object({ keyId: z.string().min(1).max(200), encryptedToken: z.string().min(1).max(20_000) })
  .strict();

function handle(fn: (req: ProjectsRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<ProjectsRequest>(async (req, res) => {
    const userId = typeof req.userId === 'string' && req.userId !== '' ? req.userId : null;
    if (userId === null) {
      res.status(400).json({ error: 'X-User-Id (or user_id) is required for API-key calls' });
      return;
    }
    try {
      await fn(req, res, userId);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      log.info('GitHub credential request refused', {
        userId,
        status: error.status,
        code: error.code,
      });
      res
        .status(error.status)
        .json({ error: error.message, ...(error.code !== undefined ? { code: error.code } : {}) });
    }
  });
}

router.use(withProjectsAuth);

router.get(
  '/',
  handle(async (req, res, userId) => {
    const repo = typeof req.query.repo === 'string' ? req.query.repo.trim().slice(0, 500) : '';
    res.json(await credential.getGithubCredential(userId, repo === '' ? undefined : repo));
  })
);

router.put(
  '/',
  handle(async (req, res, userId) => {
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid body',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }
    res.json(await credential.importGithubCredential(userId, parsed.data));
  })
);

router.delete(
  '/',
  handle(async (req, res, userId) => {
    if (req.cliScope !== undefined) {
      res.status(403).json({
        error: 'Remove your GitHub credential in Rose, not from the CLI',
        code: 'cli_scope',
      });
      return;
    }
    res.json(await credential.removeGithubCredential(userId));
  })
);

export default router;
