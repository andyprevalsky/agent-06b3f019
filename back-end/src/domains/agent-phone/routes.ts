import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { fetchAgentPhoneMessagesSince } from './service';

const router = Router();

router.get(
  '/messages',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId =
      req.user?.id ?? (req.isInternal === true ? (req.headers['x-user-id'] as string) : undefined);
    if (userId === undefined || userId === null || userId === '') {
      return res
        .status(400)
        .json({ error: 'Missing user ID. Use JWT auth or x-user-id header with API key.' });
    }

    const sinceParam = req.query.since as string;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 100);
    if (sinceParam === undefined || sinceParam === null || sinceParam === '') {
      return res.status(400).json({ error: 'Missing required query param: since (ISO timestamp)' });
    }

    const since = new Date(sinceParam);
    if (Number.isNaN(since.getTime())) {
      return res.status(400).json({ error: 'Invalid since timestamp' });
    }

    const messages = await fetchAgentPhoneMessagesSince(userId, since, limit);
    return res.json({
      messages: messages.map((message) => ({
        id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        channel: message.channel,
        date: message.receivedAt.toISOString(),
        credentialId: message.credentialId,
        credentialPhone: message.credentialPhone,
      })),
      count: messages.length,
      since: since.toISOString(),
    });
  })
);

export default router;
