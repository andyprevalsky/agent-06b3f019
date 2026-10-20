import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../providers/logger';
import { handleErrorAlert, handleFeedback } from './incidentService';
import { parseSlackAutoRcaEvent, slackSigningConfigured, verifySlackRequest } from './service';
import type { ParsedSlackAutoRcaEvent, SlackAutoRcaOutcome } from './types';

const log = createLogger('SlackAutoRca');
const router = Router();

function dispatch(parsed: ParsedSlackAutoRcaEvent): Promise<SlackAutoRcaOutcome> | null {
  if (parsed.kind === 'error_alert') return handleErrorAlert(parsed.alert);
  if (parsed.kind === 'feedback') return handleFeedback(parsed.feedback);
  return null;
}

async function handleSlackAutoRcaEvent(req: Request, res: Response): Promise<void> {
  if (!slackSigningConfigured()) {
    res.status(503).json({ error: 'Slack auto-RCA is not configured' });
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
  const work = dispatch(parsed);
  if (work === null) {
    res.json({ ok: true });
    return;
  }
  const eventId =
    parsed.kind === 'error_alert'
      ? parsed.alert.eventId
      : parsed.kind === 'feedback'
        ? parsed.feedback.eventId
        : undefined;
  try {
    // Acknowledge only after the agent exists or received the message. A non-2xx
    // makes Slack redeliver; the event-id claim keeps redelivery idempotent.
    const outcome = await work;
    log.info('Slack auto-RCA event handled', { event_id: eventId, ...outcome });
    res.json({ ok: true, ...outcome });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Slack auto-RCA event failed', { event_id: eventId, error: message });
    res.status(503).json({ error: message });
  }
}

router.post('/', (req, res) => {
  void handleSlackAutoRcaEvent(req, res).catch((error: unknown) => {
    log.error('Unexpected Slack auto-RCA webhook failure', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) res.status(500).json({ error: 'Slack auto-RCA webhook failed' });
  });
});

export default router;
