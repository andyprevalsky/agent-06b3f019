import { createLogger } from '../../providers/logger';
import { ELEVENLABS_API_KEY, VOICE_PREVIEW_CACHE_TTL_MS } from './config';

const log = createLogger('VoicesService');

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
  const response = await fetch(
    `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`,
    {
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    }
  );
  if (!response.ok) {
    log.warn('ElevenLabs voice lookup failed', { voiceId, status: response.status });
    return null;
  }
  const body = (await response.json()) as ElevenLabsVoiceResponse;
  return typeof body.preview_url === 'string' && body.preview_url.length > 0
    ? body.preview_url
    : null;
}

export async function getCachedPreviewUrl(voiceId: string): Promise<string | null> {
  const cached = cache.get(voiceId);
  if (cached !== undefined && cached.expiresAt > Date.now()) {
    return cached.url;
  }
  const url = await fetchPreviewUrl(voiceId);
  cache.set(voiceId, { url, expiresAt: Date.now() + VOICE_PREVIEW_CACHE_TTL_MS });
  return url;
}
