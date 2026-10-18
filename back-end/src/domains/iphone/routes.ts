import { Router } from 'express';
import { hybridAuth, type HybridAuthRequest } from '../../providers/hybridAuth';
import { asyncHandler } from '../../utils/asyncHandler';
import { createLogger } from '../../providers/logger';
import * as service from './service';
import { IPhoneError, type ActionInput, type LeaseAction } from './types';

const router = Router();
const log = createLogger('IPhone');

function bodyRecord(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new IPhoneError(400, 'Request body must be an object');
  return body as Record<string, unknown>;
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > 512)
    throw new IPhoneError(400, `${key} must be a nonempty string of at most 512 characters`);
  return value;
}
function actionInput(action: LeaseAction, body: unknown): ActionInput {
  if (action === 'awaiting-auth')
    return { attentionRequestId: text(bodyRecord(body), 'attentionRequestId') };
  if (action !== 'control') return {};
  const mode = bodyRecord(body).mode;
  if (mode !== 'user' && mode !== 'agent') throw new IPhoneError(400, 'mode must be user or agent');
  return { mode };
}

type Handler = (req: HybridAuthRequest, userId: string) => Promise<unknown>;
function handle(handler: Handler, status = 200) {
  return asyncHandler<HybridAuthRequest>(async (req, res) => {
    try {
      const userId = req.userId;
      if (userId === undefined || userId === '') throw new IPhoneError(401, 'User scope required');
      res.status(status).json(await handler(req, userId));
    } catch (error) {
      if (error instanceof IPhoneError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'P2002'
      ) {
        res.status(409).json({ error: 'Device is already bound' });
        return;
      }
      log.error('iPhone operation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'iPhone operation failed' });
    }
  });
}
router.use(asyncHandler(hybridAuth));
router.get(
  '/capability',
  handle((_req, userId) => service.capability(userId))
);
router.put(
  '/device',
  handle(async (req, userId) => {
    if (req.isInternal !== true) throw new IPhoneError(403, 'Internal API key required');
    return service.bind(userId, text(bodyRecord(req.body), 'providerDeviceId'));
  })
);
router.post(
  '/leases',
  handle((req, userId) => {
    const body = bodyRecord(req.body);
    return service.acquire(userId, {
      agentId: text(body, 'agentId'),
      requestKey: text(body, 'requestKey'),
      ...(body.browserTaskId !== undefined ? { browserTaskId: text(body, 'browserTaskId') } : {}),
    });
  }, 201)
);
router.get(
  '/leases/:id',
  handle((req, userId) => service.act(userId, req.params.id, 'read', {}))
);
for (const action of ['heartbeat', 'release', 'awaiting-auth', 'control'] as const) {
  router.post(
    `/leases/:id/${action}`,
    handle((req, userId) =>
      service.act(userId, req.params.id, action, actionInput(action, req.body))
    )
  );
}
export default router;
