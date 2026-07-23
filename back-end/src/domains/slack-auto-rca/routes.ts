import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../providers/logger';
import {
  parseSlackAutoRcaEvent,
  queueSlackAutoRcaFeedback,
  slackSigningConfigured,
  verifySlackRequest,
} from './service';

const log = createLogger('SlackAutoRca');
const router = Router();

async function handleSlackAutoRcaEvent(req: Request, res: Response): Promise<void> {
  if (!slackSigningConfigured()) {
    res.status(503).json({ error: 'Slack feedback is not configured' });
    return;
  }
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? '';
  const timestampHeader = req.headers['x-slack-request-timestamp'];
  const signatureHeader = req.headers['x-slack-signature'];
  const timestamp = typeof timestampHeader === 'string' ? timestampHeader : undefined;
  const signature = typeof signatureHeader === 'string' ? signatureHeader : undefined;
  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    res.status(401).json({ error: 'Invalid Slack signature' });
    return;
  }

  const parsed = parseSlackAutoRcaEvent(req.body);
  if (parsed.kind === 'challenge') {
    res.json({ challenge: parsed.challenge });
    return;
  }
  if (parsed.kind === 'feedback') {
    try {
      // Slack retries non-2xx deliveries. Do not acknowledge the webhook until
      // GitHub has accepted the durable repository event, otherwise a process
      // crash between the 200 and dispatch would silently lose human feedback.
      await queueSlackAutoRcaFeedback(parsed.feedback);
    } catch (error: unknown) {
      log.error('Failed to durably queue Slack RCA feedback', {
        event_id: parsed.feedback.eventId,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({ error: 'Could not queue Slack feedback; retry delivery' });
      return;
    }
    res.json({ ok: true });
    return;
  }
  res.json({ ok: true });
}

router.post('/', (req, res) => {
  void handleSlackAutoRcaEvent(req, res).catch((error: unknown) => {
    log.error('Unexpected Slack RCA webhook failure', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) res.status(500).json({ error: 'Slack feedback webhook failed' });
  });
});

export default router;
