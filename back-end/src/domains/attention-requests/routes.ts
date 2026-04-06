import { Router, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../utils/asyncHandler';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { NotFoundError, ForbiddenError } from './service';
import { createAttentionRequestSchema, respondSchema } from './types';

const log = createLogger('Attention');
const router = Router();

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapError(error: unknown, res: Response): void {
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
  asyncHandler(async (req, res) => {
    try {
      const data = createAttentionRequestSchema.parse(req.body);
      const result = await service.create(data);
      res.json(result);
    } catch (error) {
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
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const result = await service.listForUser(req.user!.id);
      res.json(result);
    } catch (error) {
      log.error('Failed to fetch attention requests', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to fetch attention requests' });
    }
  })
);

router.get(
  '/count',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const result = await service.countForUser(req.user!.id);
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
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const data = respondSchema.parse(req.body);
      const result = await service.respond(req.params.id, req.user!.id, data);
      res.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid response data', details: error.errors });
        return;
      }
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
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
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const result = await service.skip(req.params.id, req.user!.id);
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
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const message = typeof body?.message === 'string' ? body.message : undefined;
      const result = await service.reject(req.params.id, req.user!.id, message);
      res.json(result);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ForbiddenError) {
        mapError(error, res);
        return;
      }
      log.error('Failed to reject attention request', { error: errMsg(error) });
      res.status(500).json({ error: 'Failed to reject attention request' });
    }
  })
);

export default router;
