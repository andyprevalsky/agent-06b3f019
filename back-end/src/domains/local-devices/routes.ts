/**
 * Local devices routes (C14) — thin controller layer.
 *
 * POST /api/local-devices/register              Mac app main process (user JWT, never impersonated)
 * GET  /api/local-devices                       owner's devices + live connectivity (UI switch)
 * GET  /api/local-devices/agent-target/:agentId worker only (API key): may this agent run locally now?
 *
 * WebSockets (attached in service.attachLocalDeviceServer):
 *   /api/local-devices/control                  Mac app control channel
 *   /api/local-code-relay/:taskId[/device]      per-session relay (worker/chip ⇄ Mac)
 */
import { type Response, Router } from 'express';
import { z } from 'zod';
import { type AuthRequest, authenticate, authenticateMachineUpload } from '../../providers/auth';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';
import { DeviceOwnedByAnotherUserError } from './service';
import { registerDeviceSchema } from './types';

const log = createLogger('LocalDevicesRoutes');
const router = Router();

router.post(
  '/register',
  ...authenticateMachineUpload,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (userId === undefined) {
      res.status(401).json({ error: 'A signed-in Rose Mac app session is required' });
      return;
    }
    const parsed = registerDeviceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid device registration', issues: parsed.error.issues });
      return;
    }
    try {
      res.json({ success: true, device: await service.registerDevice(userId, parsed.data) });
    } catch (error) {
      if (error instanceof DeviceOwnedByAnotherUserError) {
        res.status(403).json({ error: error.message, code: 'DEVICE_OWNED_BY_ANOTHER_USER' });
        return;
      }
      log.error('Device registration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to register device' });
    }
  })
);

router.get(
  '/',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (userId === undefined) {
      res.status(401).json({ error: 'A signed-in user is required' });
      return;
    }
    res.json({ devices: await service.listDevices(userId) });
  })
);

router.get(
  '/agent-target/:agentId',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (req.isInternal !== true) {
      res.status(403).json({ error: 'Internal callers only' });
      return;
    }
    const agentId = z.string().uuid().safeParse(req.params.agentId);
    if (!agentId.success) {
      res.status(400).json({ error: 'agentId must be a UUID' });
      return;
    }
    res.json(await service.agentTarget(agentId.data));
  })
);

export default router;
