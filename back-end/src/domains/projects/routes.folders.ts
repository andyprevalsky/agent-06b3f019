/** Folder routes share the parent projects router's auth, scope and error helpers. */
import type { RequestHandler, Response, Router } from 'express';
import type { z } from 'zod';
import * as folders from './folderService';
import { projectFolderSchema, projectFolderPositionSchema } from './types';

type Handler<Req> = (req: Req, res: Response, userId: string) => Promise<void>;

interface FolderRouteHelpers<Req> {
  handle: (fn: Handler<Req>) => RequestHandler;
  idParam: (req: Req, res: Response, name?: string) => string | null;
  parse: <S extends z.ZodTypeAny>(schema: S, body: unknown, res: Response) => z.infer<S> | null;
}

export function registerFolderRoutes<Req extends { body?: unknown }>(
  router: Router,
  { handle, idParam, parse }: FolderRouteHelpers<Req>
): void {
  router.get(
    '/:id/folders',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      if (id !== null) res.json(await folders.listFolders(userId, id));
    })
  );

  router.post(
    '/:id/folders',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const body = id !== null ? parse(projectFolderSchema, req.body, res) : null;
      if (id !== null && body !== null)
        res.status(201).json(await folders.createFolder(userId, id, body.name));
    })
  );

  router.put(
    '/:id/folders/:folderId/position',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const folderId = id !== null ? idParam(req, res, 'folderId') : null;
      const body = folderId !== null ? parse(projectFolderPositionSchema, req.body, res) : null;
      if (id !== null && folderId !== null && body !== null) {
        res.json(await folders.moveFolder(userId, id, folderId, body.beforeId));
      }
    })
  );

  router.put(
    '/:id/folders/:folderId',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const folderId = id !== null ? idParam(req, res, 'folderId') : null;
      const body = folderId !== null ? parse(projectFolderSchema, req.body, res) : null;
      if (id !== null && folderId !== null && body !== null)
        res.json(await folders.renameFolder(userId, id, folderId, body.name));
    })
  );

  router.delete(
    '/:id/folders/:folderId',
    handle(async (req, res, userId) => {
      const id = idParam(req, res);
      const folderId = id !== null ? idParam(req, res, 'folderId') : null;
      if (id === null || folderId === null) return;
      await folders.deleteFolder(userId, id, folderId);
      res.status(204).end();
    })
  );
}
