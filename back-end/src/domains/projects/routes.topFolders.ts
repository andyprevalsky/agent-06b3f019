/**
 * /api/folders — folders replace projects in the product (topFolderService.ts).
 *
 *   GET    /api/folders        list {folders: [{id, name, legacy_project_id, subfolders, github_repo}]}
 *   POST   /api/folders        create {name} (never a repo: connect repos on the integrations panel)
 *   GET    /api/folders/:id    one folder
 *   PATCH  /api/folders/:id    rename {name}
 *   DELETE /api/folders/:id    delete (agents fall back to Home, as for projects)
 *
 * Subfolders keep their routes: /api/projects/:id/folders. Auth: user JWT or
 * hybrid API key (X-API-Key + X-User-Id). A foreign folder is a 404.
 */
import { Router, type Response } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { ProjectError } from './service';
import * as folders from './topFolderService';
import { projectFolderSchema, projectIdSchema } from './types';

const router = Router();

function handle(fn: (req: HybridAuthRequest, res: Response, userId: string) => Promise<void>) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    const userId = typeof req.userId === 'string' && req.userId !== '' ? req.userId : null;
    if (userId === null) {
      res.status(400).json({ error: 'X-User-Id (or user_id) is required for API-key calls' });
      return;
    }
    try {
      await fn(req, res, userId);
    } catch (error) {
      if (!(error instanceof ProjectError)) throw error;
      const message = error.message.replace(/project/gi, (word) =>
        word[0] === 'P' ? 'Folder' : 'folder'
      );
      res.status(error.status).json({ error: message });
    }
  });
}

function folderId(req: HybridAuthRequest, res: Response): string | null {
  const parsed = projectIdSchema.safeParse(req.params.id);
  if (parsed.success) return parsed.data;
  res.status(404).json({ error: 'Folder not found' });
  return null;
}

function folderName(req: HybridAuthRequest, res: Response): string | null {
  const parsed = projectFolderSchema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data.name;
  res.status(400).json({
    error: 'A folder takes only {name}; connect a GitHub repo on the integrations panel',
    details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
  });
  return null;
}

router.use((req: HybridAuthRequest, res, next) => void hybridAuth(req, res, next));

router.get(
  '/',
  handle(async (_req, res, userId) => {
    res.json(await folders.listTopFolders(userId));
  })
);

router.post(
  '/',
  handle(async (req, res, userId) => {
    const name = folderName(req, res);
    if (name !== null) res.status(201).json(await folders.createTopFolder(userId, name));
  })
);

router.get(
  '/:id',
  handle(async (req, res, userId) => {
    const id = folderId(req, res);
    if (id !== null) res.json(await folders.getTopFolder(userId, id));
  })
);

router.patch(
  '/:id',
  handle(async (req, res, userId) => {
    const id = folderId(req, res);
    const name = id !== null ? folderName(req, res) : null;
    if (id !== null && name !== null) res.json(await folders.renameTopFolder(userId, id, name));
  })
);

router.delete(
  '/:id',
  handle(async (req, res, userId) => {
    const id = folderId(req, res);
    if (id === null) return;
    await folders.deleteTopFolder(userId, id);
    res.status(204).end();
  })
);

export default router;
