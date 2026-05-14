import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';

const log = createLogger('Voices');
const router = Router();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  url: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

interface ElevenLabsVoiceResponse {
  preview_url?: string;
}

async function fetchPreviewUrl(voiceId: string): Promise<string | null> {
  if (ELEVENLABS_API_KEY === undefined || ELEVENLABS_API_KEY === '') return null;
  const response = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
    headers: { 'xi-api-key': ELEVENLABS_API_KEY },
  });
  if (!response.ok) {
    log.warn('ElevenLabs voice lookup failed', { voiceId, status: response.status });
    return null;
  }
  const body = (await response.json()) as ElevenLabsVoiceResponse;
  return typeof body.preview_url === 'string' && body.preview_url.length > 0
    ? body.preview_url
    : null;
}

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

    const cached = cache.get(voiceId);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      if (cached.url === null) {
        res.status(404).json({ error: 'preview not available' });
        return;
      }
      res.json({ url: cached.url });
      return;
    }

    const url = await fetchPreviewUrl(voiceId);
    cache.set(voiceId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
    if (url === null) {
      res.status(404).json({ error: 'preview not available' });
      return;
    }
    res.json({ url });
  })
);

export default router;
