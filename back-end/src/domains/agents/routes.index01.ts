/**
 * Index 01 (Pebble) "Also send to webhook": POST /api/index01/webhook with
 * `Authorization: Bearer <rose-api-key>` (or `X-API-Key`). Each transcribed
 * Hold & Talk recording becomes a plan-mode rose-1-ultra cloud agent.
 * Accepts JSON or multipart; audio files are archived to the user's storage
 * (index01-recording_*) for later reprocessing. Payloads without a transcript (test events, recording-only) are acknowledged
 * and their key/type outline is logged so the schema stays observable.
 */

import { Router, type Request } from 'express';
import { getClientIP } from '../../providers/geoip';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  archiveIndex01Recordings,
  describePayloadShape,
  normalizeWebhookBody,
  extractTranscript,
  resolveMcpUser,
  spawnIndex01Agent,
} from './agentMcpService';
import { index01WebhookUpload } from './config';

const log = createLogger('Index01Webhook');
const router = Router();

function roseApiKeyFrom(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const apiKey = req.headers['x-api-key'];
  return typeof apiKey === 'string' && apiKey !== '' ? apiKey : undefined;
}

router.post(
  '/webhook',
  index01WebhookUpload.any(),
  asyncHandler(async (req, res) => {
    const apiKey = roseApiKeyFrom(req);
    if (apiKey === undefined) {
      res.status(401).json({ error: 'Authorization: Bearer <rose-api-key> required' });
      return;
    }
    const resolved = await resolveMcpUser(apiKey);
    if ('error' in resolved) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    const body = normalizeWebhookBody(req.body);
    const files = Array.isArray(req.files) ? req.files : [];
    const transcript = extractTranscript(body);
    const recordings = await archiveIndex01Recordings(resolved.userId, files);
    log.info('Index 01 webhook received', {
      userId: resolved.userId,
      contentType: req.headers['content-type'] ?? null,
      shape: JSON.stringify(describePayloadShape(body)).slice(0, 1000),
      files: files.map((f) => ({ field: f.fieldname, mime: f.mimetype, bytes: f.size })),
      recordings,
      hasTranscript: transcript !== null,
    });
    if (transcript === null) {
      res
        .status(200)
        .json({ received: true, spawned: false, recordings, reason: 'no transcript in payload' });
      return;
    }
    try {
      const agent = await spawnIndex01Agent(
        transcript,
        resolved.userId,
        getClientIP(req),
        'webhook'
      );
      res.status(201).json({ received: true, spawned: true, recordings, ...agent });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('Index 01 webhook spawn failed', { userId: resolved.userId, error: message });
      res.status(500).json({ error: `Failed to start Rose agent: ${message}` });
    }
  })
);

export default router;
