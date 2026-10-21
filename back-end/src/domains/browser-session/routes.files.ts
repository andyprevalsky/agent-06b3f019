import { type Response, type Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import {
  TilionInsufficientCreditsError,
  TilionSessionBusyError,
} from '../../providers/browser/tilion';
import { asyncHandler } from '../../utils/asyncHandler';
import { isValidBrowserKeySymbols } from './service.browser-input';
import {
  downloadFile,
  InvalidSessionFilePathError,
  pressKeys,
  SessionNotFoundError,
  takeScreenshot,
} from './service';

/**
 * Typed provider refusals instead of a 500: 409 when a CDP client (the agent)
 * holds a Tilion session so REST drive calls are refused, 402 when the Tilion
 * wallet is exhausted.
 */
export function respondToTilionRefusal(error: unknown, res: Response): boolean {
  if (error instanceof TilionSessionBusyError) {
    res.status(409).json({
      error: 'session_driven_by_client',
      provider: 'tilion',
      retryable_after_detach: true,
      message: error.message,
    });
    return true;
  }
  if (error instanceof TilionInsufficientCreditsError) {
    res
      .status(402)
      .json({ error: 'insufficient_credits', provider: 'tilion', message: error.message });
    return true;
  }
  return false;
}

function userIdForSessionAccess(req: AuthRequest): string | undefined {
  return req.isInternal === true ? undefined : req.user?.id;
}

function userIdForOwnedSessionAccess(req: AuthRequest): string | undefined {
  const rawUserId = req.isInternal === true ? req.headers['x-user-id'] : req.user?.id;
  return typeof rawUserId === 'string' && rawUserId.trim() !== '' ? rawUserId.trim() : undefined;
}

async function handlePressKey(req: AuthRequest, res: Response): Promise<void> {
  try {
    const userId = userIdForOwnedSessionAccess(req);
    if (userId === undefined) {
      res.status(401).json({ error: 'User not authenticated' });
      return;
    }
    const body = req.body as { keys?: unknown } | undefined;
    if (!isValidBrowserKeySymbols(body?.keys)) {
      res.status(400).json({
        error: 'keys must contain between 1 and 16 non-empty key symbols of at most 64 characters',
      });
      return;
    }
    const result = await pressKeys(req.params.sessionId, body.keys, userId);
    res.json(result);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    if (respondToTilionRefusal(error, res)) return;
    throw error;
  }
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
        if (respondToTilionRefusal(error, res)) return;
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
        if (respondToTilionRefusal(error, res)) return;
        throw error;
      }
    })
  );

  router.post('/:sessionId/computer/press-key', authenticate, asyncHandler(handlePressKey));
}
