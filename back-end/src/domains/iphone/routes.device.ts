/** Owner device routes: status and live screen, independent of lease custody. */
import type { RequestHandler, Router } from 'express';
import type { HybridAuthRequest } from '../../providers/hybridAuth';
import * as device from './service.device';
import { PhoneDeviceUnavailable, type IPhoneError } from './types';
import type { PhoneClientFactory } from './types.operations';

type Wrap = (
  handler: (req: HybridAuthRequest, userId: string) => Promise<unknown>
) => RequestHandler;

/** Unavailable live views carry their observable state: provider state, busy, private, STALE. */
export function errorBody(error: IPhoneError) {
  return {
    error: error.message,
    ...(error instanceof PhoneDeviceUnavailable ? { state: error.state } : {}),
  };
}

export function mountDeviceRoutes(router: Router, handle: Wrap, clientFactory: PhoneClientFactory) {
  // Reconciles stale holders; never allocates or extends a lease or starts a session.
  router.get(
    '/device',
    handle((_req, userId) => device.deviceStatus(userId))
  );
  // Screen of a READY session whoever holds the lease; no task binding, custody or activity.
  router.get(
    '/device/frame',
    handle((_req, userId) => device.deviceFrame(userId, clientFactory))
  );
}
