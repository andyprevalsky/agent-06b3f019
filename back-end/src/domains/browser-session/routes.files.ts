import { type Response, type Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  downloadFile,
  InvalidSessionFilePathError,
  SessionNotFoundError,
  takeScreenshot,
} from './service';

function userIdForSessionAccess(req: AuthRequest): string | undefined {
  return req.isInternal === true ? undefined : req.user?.id;
}

export function registerBrowserDataRoutes(router: Router): void {
  router.get(
    '/:sessionId/files/content',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const filePath = typeof req.query.path === 'string' ? req.query.path : '';
        if (filePath === '') {
          res.status(400).json({ error: 'path query parameter is required' });
          return;
        }
        const result = await downloadFile(
          req.params.sessionId,
          filePath,
          userIdForSessionAccess(req)
        );
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${result.filename.replace(/"/g, '')}"`
        );
        res.send(result.content);
      } catch (error) {
        if (error instanceof InvalidSessionFilePathError) {
          res.status(400).json({ error: error.message });
          return;
        }
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );

  router.post(
    '/:sessionId/screenshot',
    authenticate,
    asyncHandler(async (req: AuthRequest, res: Response) => {
      try {
        const result = await takeScreenshot(req.params.sessionId, userIdForSessionAccess(req));
        res.json({
          provider: result.provider,
          base64_image: result.image.toString('base64'),
        });
      } catch (error) {
        if (error instanceof SessionNotFoundError) {
          res.status(404).json({ error: error.message });
          return;
        }
        throw error;
      }
    })
  );
}
