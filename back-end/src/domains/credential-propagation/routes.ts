import { Router } from 'express';
import { authenticate, type AuthRequest } from '../../providers/auth';
import { asyncHandler } from '../../utils/asyncHandler';
import { propagateBrowserRunCredentials } from './service';

const router = Router();

router.post(
  '/browser-run',
  authenticate,
  asyncHandler<AuthRequest>(async (req, res) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal API key required' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const agentId = body.agentId;
    const taskId = body.taskId;
    const status = body.status;
    const success = body.success;
    const message = body.message;

    if (
      typeof agentId !== 'string' ||
      agentId === '' ||
      typeof taskId !== 'string' ||
      taskId === '' ||
      typeof status !== 'string' ||
      status === '' ||
      typeof success !== 'boolean' ||
      typeof message !== 'string'
    ) {
      res.status(400).json({
        error: 'agentId, taskId, status, success, and message are required',
      });
      return;
    }

    const result = await propagateBrowserRunCredentials({
      agentId,
      taskId,
      status,
      success,
      message,
    });
    if (result === null) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    res.json(result);
  })
);

export default router;
