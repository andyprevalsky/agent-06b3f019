import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { getCachedPreviewUrl } from './service';

const router = Router();

/**
 * GET /api/voices/:voiceId/preview
 * Returns the ElevenLabs preview MP3 URL for a voice ID, or 404 if unavailable.
 * Public — only exposes a public CDN URL ElevenLabs already publishes.
 */
router.get(
  '/:voiceId/preview',
  asyncHandler<Request>(async (req: Request, res: Response) => {
    const { voiceId } = req.params;
    if (voiceId === undefined || voiceId === '') {
      res.status(400).json({ error: 'voiceId is required' });
      return;
    }
    const url = await getCachedPreviewUrl(voiceId);
    if (url === null) {
      res.status(404).json({ error: 'preview not available' });
      return;
    }
    res.json({ url });
  })
);

export default router;
