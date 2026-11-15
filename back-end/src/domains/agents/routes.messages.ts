/**
 * Agent message, attachment, signal, and schema routes.
 * Mounted by routes.ts.
 */

import { type Response, Router } from 'express';
import { z } from 'zod';
import { type HybridAuthRequest, hybridAuth } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { isAdminUser } from '../../utils/adminAccess';
import { createLogger } from '../../providers/logger';
import { agentMessageUpload } from '../../providers/agentMessageUpload';
import type { ResponseSchemaDirectAuth } from '../../providers/setResponseSchema';
import { postMessageSchema, generateSchemaRequestSchema } from './types';
import * as controlService from './agentControlService';
import * as messageService from './agentMessageService';
import * as messageLookupService from './agentMessageLookupService';
import * as attachmentService from './agentAttachmentService';
import * as queryService from './agentQueryService';
import { resolveAgentReadAccess } from './routes.guards';
import { workerWriteGeneration } from '../../providers/codeResumeGeneration';

const log = createLogger('Agents');
const router = Router({ mergeParams: true });
const auth = asyncHandler<HybridAuthRequest>(hybridAuth);

function handleRouteError(
  res: Response,
  error: unknown,
  msg: string,
  ctx?: Record<string, string>
): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Invalid request body', details: error.issues });
    return;
  }
  log.error(msg, {
    ...ctx,
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ error: msg });
}

function readResponseSchemaDirectAuth(
  req: HybridAuthRequest
): ResponseSchemaDirectAuth | undefined {
  if (req.isInternal !== true) return undefined;
  const type = req.header('x-compute-token-type');
  const accessToken = req.header('x-compute-access-token');
  if ((type !== 'claude' && type !== 'gpt') || accessToken === undefined || accessToken === '') {
    return undefined;
  }
  const accountId = req.header('x-gpt-account-id');
  return {
    type,
    accessToken,
    ...(accountId !== undefined && accountId !== '' ? { accountId } : {}),
  };
}

// POST /:id/messages
router.post(
  '/:id/messages',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined && req.isInternal !== true) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const body = postMessageSchema.parse(req.body);
      // Do NOT default a missing generation header to the agent id. Generation
      // 1's Temporal workflow id IS the agent id, so that default fabricated a
      // real-but-wrong generation: after any replacement, every write from a
      // writer that forgot the header looked stale and was rewritten into the
      // terminal "Tool interrupted by deployment" error. Leave it undefined and
      // let the service attribute the write to the agent's live generation.
      const generation =
        req.isInternal === true
          ? await workerWriteGeneration(req.params.id, req.header('x-agent-workflow-generation'))
          : undefined;
      const result = await messageService.postMessage(
        req.params.id,
        body,
        req.isInternal === true,
        req.userId,
        generation
      );
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.status(201).json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to post message', { agent_id: req.params.id });
    }
  })
);

// POST /:id/attachments
router.post(
  '/:id/attachments',
  auth,
  agentMessageUpload.single('file'),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.file === undefined) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await attachmentService.uploadAttachment(req.userId, req.params.id, req.file);
      res.status(201).json(result);
    } catch (error) {
      log.error('Upload attachment error', {
        agent_id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to upload attachment',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

// GET /:id/attachments/:fileId/url
router.get(
  '/:id/attachments/:fileId/url',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const storagePath = req.query.storage_path;
      if (typeof storagePath !== 'string' || storagePath === '') {
        res.status(400).json({ error: 'storage_path query parameter is required' });
        return;
      }
      if (req.userId === undefined) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await attachmentService.getAttachmentSignedUrl(req.userId, storagePath, {
        agentId: req.params.id,
        isAdmin: isAdminUser(req.userId),
      });
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      log.error('Get signed URL error', {
        agent_id: req.params.id,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: 'Failed to generate signed URL',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })
);

// POST /:id/signal/signup_completed
router.post(
  '/:id/signal/signup_completed',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined || req.userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await controlService.signalWorkflow(
        req.params.id,
        req.userId,
        'signup_completed'
      );
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to signal signup completed', {
        agent_id: req.params.id,
      });
    }
  })
);

// POST /:id/signal/signup_dismissed
router.post(
  '/:id/signal/signup_dismissed',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      if (req.userId === undefined || req.userId === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await controlService.signalWorkflow(
        req.params.id,
        req.userId,
        'signup_dismissed'
      );
      if ('error' in result) {
        res.status(result.status ?? 500).json({ error: result.error });
        return;
      }
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to signal signup dismissed', {
        agent_id: req.params.id,
      });
    }
  })
);

// POST /generate-response-schema
router.post(
  '/generate-response-schema',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const body = generateSchemaRequestSchema.parse(req.body);
      const { schema, tokensIn, tokensOut } = await messageLookupService.generateSchema(
        body.goal,
        readResponseSchemaDirectAuth(req),
        req.userId
      );
      res.json({ schema, tokensIn, tokensOut });
    } catch (error) {
      handleRouteError(res, error, 'Failed to generate response schema');
    }
  })
);

// GET /:id/messages/:messageId — one row, read with the agent-detail access rules
router.get(
  '/:id/messages/:messageId',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const { userId } = resolveAgentReadAccess(req);
      const message = await queryService.getAgentMessage(
        req.params.id,
        req.params.messageId,
        userId
      );
      if (message === null) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }
      res.json({ message });
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch message', {
        agent_id: req.params.id,
        message_id: req.params.messageId,
      });
    }
  })
);

// POST /messages/batch — batch fetch messages by IDs
router.post(
  '/messages/batch',
  auth,
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const ids = (req.body as { ids?: unknown } | null)?.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        res.status(400).json({ error: 'ids must be a non-empty array' });
        return;
      }
      if (!ids.every((id): id is string => typeof id === 'string' && id.trim() !== '')) {
        res.status(400).json({ error: 'ids must contain only non-empty strings' });
        return;
      }
      if (ids.length > 50) {
        res.status(400).json({ error: 'Maximum 50 IDs per batch request' });
        return;
      }
      const userId =
        req.userId ??
        (req.isInternal === true ? (req.headers['x-user-id'] as string | undefined) : undefined);
      if (userId === undefined || userId === null) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }
      const result = await messageLookupService.batchFetchMessages(ids, userId);
      res.json(result);
    } catch (error) {
      handleRouteError(res, error, 'Failed to fetch messages');
    }
  })
);

export default router;
