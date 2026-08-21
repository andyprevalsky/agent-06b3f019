/**
 * Integration email routes — OAuth, send, fetch.
 * Split from routes.ts for max-lines compliance.
 */

import { type Response, Router } from 'express';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import * as resyncService from './service.emailResync';

const log = createLogger('Integrations');
const router = Router({ mergeParams: true });

/** POST /api/integrations/email/:provider/start */
router.post(
  '/email/:provider/start',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    log.info('Email OAuth start', {
      provider: req.params.provider,
      userId: req.user?.id?.slice(0, 8),
    });

    const providerKey = service.normalizeProvider(req.params.provider);
    if (providerKey === undefined || providerKey === null) {
      return res.status(400).json({ error: 'Unsupported email provider' });
    }

    const internalUserId =
      req.isInternal === true && typeof req.body?.user_id === 'string'
        ? req.body.user_id.trim()
        : undefined;
    const userId = req.isInternal === true ? internalUserId : req.user?.id;
    if (userId === undefined || userId === '') {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const returnUrl = (req.body?.returnUrl as string | undefined) ?? null;
    const errorUrl = (req.body?.errorUrl as string | undefined) ?? null;

    const result = await service.startEmailOAuth(userId, providerKey, returnUrl, errorUrl);
    return res.json(result);
  })
);

/** GET /api/integrations/email/:provider/callback */
router.get(
  '/email/:provider/callback',
  asyncHandler(async (req, res: Response) => {
    const codePresent = typeof req.query.code === 'string' ? 'present' : 'missing';
    const statePresent = typeof req.query.state === 'string' ? 'present' : 'missing';

    log.info('Email OAuth callback', {
      provider: req.params.provider,
      code: codePresent,
      state: statePresent,
    });

    const providerKey = service.normalizeProvider(req.params.provider);
    if (providerKey === undefined || providerKey === null) {
      return service.sendOAuthResult(res, {
        success: false,
        message: 'Unsupported email provider',
      });
    }

    const { code, state } = req.query;
    if (typeof code !== 'string') {
      return service.sendOAuthResult(res, {
        success: false,
        message: 'Missing authorization code',
      });
    }
    if (typeof state !== 'string') {
      return service.sendOAuthResult(res, {
        success: false,
        message: 'Missing OAuth state',
      });
    }

    try {
      await service.handleOAuthCallback(providerKey, code, state, res);
    } catch (error: unknown) {
      log.error('Error handling email OAuth callback', {
        error: error instanceof Error ? error.message : String(error),
      });
      return service.sendOAuthResult(res, {
        success: false,
        message: 'Failed to connect email account. Please try again.',
      });
    }
  })
);

/** GET /api/integrations/email/messages */
router.get(
  '/email/messages',
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
    if (isNaN(since.getTime())) {
      return res.status(400).json({ error: 'Invalid since timestamp' });
    }

    try {
      const emails = await service.fetchEmailsSince(userId, since, limit);

      return res.json({
        emails: emails.map((email) => ({
          from: email.from,
          fromName: email.fromName,
          to: email.to,
          cc: email.cc,
          subject: email.subject,
          date: email.date.toISOString(),
          bodyText: email.bodyText,
          bodyHtml: email.bodyHtml,
          credentialId: email.credentialId,
          credentialEmail: email.credentialEmail,
        })),
        count: emails.length,
        since: since.toISOString(),
      });
    } catch (error: unknown) {
      if (error instanceof service.GmailNotConnectedError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof service.GmailCredentialsNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/email/gmail/accounts/:email/resync */
router.post(
  '/email/gmail/accounts/:email/resync',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const email = req.params.email;
    if (typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({ error: 'Missing Gmail account email' });
    }

    try {
      const result = await resyncService.resyncGmailAccount(req.user!.id, email);
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof resyncService.GmailAccountNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** DELETE /api/integrations/email/gmail/accounts/:email */
router.delete(
  '/email/gmail/accounts/:email',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const email = req.params.email;
    if (typeof email !== 'string' || email.trim() === '') {
      return res.status(400).json({ error: 'Missing Gmail account email' });
    }

    try {
      const result = await service.disconnectGmailAccount(req.user!.id, email);
      return res.json({
        message: 'Gmail account disconnected successfully',
        ...result,
      });
    } catch (error: unknown) {
      if (error instanceof service.GmailAccountNotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      throw error;
    }
  })
);

/** POST /api/integrations/email/send */
router.post(
  '/email/send',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { to, subject, body, cc, user_id, from_email, agent_id } = req.body;
    const userId = req.isInternal === true ? user_id : req.user!.id;
    const agentId =
      req.isInternal === true && typeof agent_id === 'string' && agent_id !== ''
        ? agent_id
        : undefined;

    if (userId === undefined || userId === null || userId === '') {
      return res.status(401).json({ error: 'Unauthorized: user_id required for internal auth' });
    }

    if (typeof to !== 'string' || to === '') {
      return res.status(400).json({ error: 'Missing required field: to' });
    }
    if (typeof subject !== 'string' || subject === '') {
      return res.status(400).json({ error: 'Missing required field: subject' });
    }
    if (typeof body !== 'string' || body === '') {
      return res.status(400).json({ error: 'Missing required field: body' });
    }

    // Always require from_email
    if (from_email === undefined || from_email === null || from_email === '') {
      const available = await service.getAvailableGmailEmails(userId);
      if (available.length > 0) {
        return res.status(400).json({
          error: 'from_email required',
          message: `from_email is required. Available connected accounts: ${available.join(', ')}`,
        });
      }
      return res.status(400).json({
        error: 'Gmail not connected',
        message:
          'No Gmail accounts connected. Connect your Gmail by clicking on the hamburger icon > Integrations > Connect Gmail',
      });
    }

    try {
      const result = await service.sendEmail(userId, {
        to,
        subject,
        body,
        cc,
        fromEmail: from_email,
        agentId,
      });

      return res.json({
        success: true,
        messageId: result.id,
        threadId: result.threadId,
      });
    } catch (error: unknown) {
      if (error instanceof service.GmailAccountNotFoundError) {
        return res.status(400).json({ error: 'Gmail not connected', message: error.message });
      }
      if (error instanceof service.GmailTokenExpiredError) {
        return res.status(400).json({ error: 'Gmail token expired', message: error.message });
      }
      if (error instanceof service.GmailAuthFailedError) {
        return res
          .status(400)
          .json({ error: 'Gmail authentication failed', message: error.message });
      }
      throw error;
    }
  })
);

export default router;
