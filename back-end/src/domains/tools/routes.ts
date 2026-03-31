import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';

const log = createLogger('Tools');
const router = Router();

// GET /api/tools - Get all available tools
router.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const result = await service.listTools();
      res.json(result);
    } catch (error) {
      log.error('Get tools error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to fetch tools' });
    }
  })
);

export default router;
