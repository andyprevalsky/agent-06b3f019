/**
 * GitHub repo integration routes (the integrations panel's "GitHub repos").
 *
 *   GET    /api/integrations/github/repos                 accessible-repo inventory
 *                                                         {repos: [{repo_name, repo_url, canonical_ref, ...}]}
 *                                                         (agents service, or ?include_shared=true: plus
 *                                                         teammates' shared repos, each with `shared`)
 *   POST   /api/integrations/github/repos                 connect {repo_url, connected_rose_project_ref?, default_branch?, replace?}
 *                                                         (replace: switch a folder that already has another repo; else 409)
 *   GET    /api/integrations/github/repos/resolve?ref=    canonical connection of any ref spelling
 *                                                         (gh:owner/repo, repo URL, project id, rose-project:<id>)
 *   DELETE /api/integrations/github/repos/:ref            disconnect (ref URL-encoded, any spelling)
 *
 * Auth: user JWT, or internal API key + X-User-Id (agents service: root context inventory).
 */
import { type Response, Router } from 'express';
import { z } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { githubBranchSchema } from '../../providers/githubRepos/branch';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  GithubRepoIntegrationError,
  connectGithubRepo,
  disconnectGithubRepo,
  listGithubRepos,
  resolveGithubRepo,
} from './service.githubRepos';

const router = Router();

const connectSchema = z.object({
  repo_url: z.string().min(1).max(500),
  connected_rose_project_ref: z.string().uuid().nullable().optional(),
  default_branch: githubBranchSchema.optional(),
  replace: z.boolean().optional(),
});

function resolveUserId(req: AuthRequest): string | undefined {
  const id = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined;
}

function handle(fn: (req: AuthRequest, res: Response, userId: string) => Promise<Response>) {
  return asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = resolveUserId(req);
    if (userId === undefined) return res.status(401).json({ error: 'User not authenticated' });
    try {
      return await fn(req, res, userId);
    } catch (error) {
      if (!(error instanceof GithubRepoIntegrationError)) throw error;
      if (error.retryAfterS !== undefined) res.setHeader('Retry-After', String(error.retryAfterS));
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
  });
}

router.get(
  '/github/repos',
  authenticate,
  handle(async (req, res, userId) =>
    res.json(
      await listGithubRepos(userId, {
        includeShared: req.isInternal === true || req.query.include_shared === 'true',
      })
    )
  )
);

router.post(
  '/github/repos',
  authenticate,
  handle(async (req, res, userId) => {
    const parsed = connectSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'INVALID_BODY',
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return res.status(201).json(await connectGithubRepo(userId, parsed.data));
  })
);

router.get(
  '/github/repos/resolve',
  authenticate,
  handle(async (req, res, userId) => {
    const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
    if (ref === '') return res.status(400).json({ error: 'REF_REQUIRED' });
    return res.json(await resolveGithubRepo(userId, ref));
  })
);

router.delete(
  '/github/repos/:ref',
  authenticate,
  handle(async (req, res, userId) => res.json(await disconnectGithubRepo(userId, req.params.ref)))
);

export default router;
