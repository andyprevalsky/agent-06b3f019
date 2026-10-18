import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import {
  AttentionUserMessageConflictError,
  AttentionUserMessageForbiddenError,
  BadRequestError,
  NotFoundError,
  ForbiddenError,
} from './service';
import { createAttentionRequestSchema, respondSchema } from './types';
import { AttentionWorkflowTargetOwnershipError } from '../../providers/attentionWorkflowTargets';
import { NativePhoneAttentionError } from '../../providers/nativePhoneAttention';

const log = createLogger('Attention');
const router = Router();

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapError(error: unknown, res: Response): void {
  if (error instanceof NativePhoneAttentionError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (
    error instanceof AttentionUserMessageForbiddenError ||
    error instanceof AttentionWorkflowTargetOwnershipError
  ) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof AttentionUserMessageConflictError) {
    res.status(409).json({ error: error.message });
    return;
  }
  if (error instanceof BadRequestError) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof NotFoundError) {
    res.status(404).json({ error: error.message });
    return;
  }
  if (error instanceof ForbiddenError) {
    res.status(403).json({ error: error.message });
    return;
  }
  throw error;
}

router.post(
  '/',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const data = createAttentionRequestSchema.parse(req.body);
      if (req.isInternal !== true) {
        const userId = req.userId ?? req.user?.id;
        if (userId === undefined) throw new ForbiddenError('Not authorized');
        await service.validateCreateOwnership(data, userId);
      }
      const result = await service.create(data);
      res.json(result);
    } catch (error) {
      if (
        error instanceof ForbiddenError ||
        error instanceof AttentionUserMessageForbiddenError ||
        error instanceof AttentionWorkflowTargetOwnershipError
      ) {
        mapError(error, res);
        return;
      }
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid request data', details: error.errors });
        return;
      }
      log.error('Failed to create attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to create attention request' });
    }
  })
);

router.get(
  '/',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId ?? req.user?.id;
      if (userId === undefined) {
        res.status(400).json({ error: 'User ID required' });
        return;
      }
      const result = await service.listForUser(userId);
      res.json(result);
    } catch (error) {
      log.error('Failed to fetch attention requests', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to fetch attention requests' });
    }
  })
);

router.get(
  '/count',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId ?? req.user?.id;
      if (userId === undefined) {
        res.status(400).json({ error: 'User ID required' });
        return;
      }
      const result = await service.countForUser(userId);
      res.json(result);
    } catch (error) {
      log.error('Failed to count attention requests', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to count attention requests' });
    }
  })
);

router.get(
  '/:id',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const result = await service.getById(req.params.id, req.userId, req.isInternal === true);
      res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        mapError(error, res);
        return;
      }
      log.error('Failed to fetch attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to fetch attention request' });
    }
  })
);

router.post(
  '/:id/respond',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId ?? req.user?.id;
      if (userId === undefined) {
        res.status(400).json({ error: 'User ID required' });
        return;
      }
      const data = respondSchema.parse(req.body);
      const result = await service.respond(req.params.id, userId, data);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid response data', details: error.errors });
        return;
      }
      if (
        error instanceof BadRequestError ||
        error instanceof NotFoundError ||
        error instanceof ForbiddenError ||
        error instanceof AttentionUserMessageConflictError ||
        error instanceof AttentionUserMessageForbiddenError ||
        error instanceof NativePhoneAttentionError ||
        error instanceof AttentionWorkflowTargetOwnershipError
      ) {
        mapError(error, res);
        return;
      }
      log.error('Failed to respond to attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to respond to attention request' });
    }
  })
);

router.post(
  '/:id/skip',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId ?? req.user?.id;
      if (userId === undefined) {
        res.status(400).json({ error: 'User ID required' });
        return;
      }
      const result = await service.skip(req.params.id, userId);
      res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        mapError(error, res);
        return;
      }
      log.error('Failed to skip attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to skip attention request' });
    }
  })
);

router.post(
  '/:id/reject',
  asyncHandler(hybridAuth),
  asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId ?? req.user?.id;
      if (userId === undefined) {
        res.status(400).json({ error: 'User ID required' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const message = typeof body?.message === 'string' ? body.message : undefined;
      const result = await service.reject(req.params.id, userId, message);
      res.json(result);
    } catch (error) {
      if (
        error instanceof NotFoundError ||
        error instanceof ForbiddenError ||
        error instanceof AttentionUserMessageConflictError ||
        error instanceof AttentionUserMessageForbiddenError ||
        error instanceof AttentionWorkflowTargetOwnershipError
      ) {
        mapError(error, res);
        return;
      }
      log.error('Failed to reject attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to reject attention request' });
    }
  })
);

export default router;
