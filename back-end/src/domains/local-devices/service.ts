/**
 * Local devices domain service (C14): Mac app registration, the owner's device
 * list (for the UI's This Mac / Cloud switch) and the worker's target check.
 */
import type { Server } from 'http';
import { localDeviceHub, setLocalDeviceHubFactory } from '../../providers/localDevices/hub';
import { RoutedLocalDeviceHub } from '../../providers/localDevices/routedHub';
import { resolveLocalTarget } from '../../providers/localDevices/session';
import { DEFAULT_DEVICE_PLATFORM } from './config';
import * as repo from './repo';
import type { AgentTargetView, LocalDeviceView, RegisterDeviceBody } from './types';

export { DeviceOwnedByAnotherUserError } from './repo';

// More than one backend instance may serve a Mac's sockets: route between them.
setLocalDeviceHubFactory(() => new RoutedLocalDeviceHub());

async function toView(device: repo.LocalDeviceRecord): Promise<LocalDeviceView> {
  return {
    device_id: device.id,
    name: device.name,
    platform: device.platform,
    app_version: device.appVersion,
    connected: await localDeviceHub().deviceOnline(device.id),
    last_seen_at: device.lastSeenAt.toISOString(),
  };
}

export async function registerDevice(
  userId: string,
  body: RegisterDeviceBody
): Promise<LocalDeviceView> {
  const device = await repo.registerLocalDevice({
    deviceId: body.device_id,
    userId,
    name: body.name,
    platform: body.platform ?? DEFAULT_DEVICE_PLATFORM,
    appVersion: body.app_version ?? null,
  });
  return toView(device);
}

export async function listDevices(userId: string): Promise<LocalDeviceView[]> {
  return Promise.all((await repo.listLocalDevices(userId)).map(toView));
}

export async function agentTarget(agentId: string): Promise<AgentTargetView> {
  const target = await resolveLocalTarget(agentId);
  return target.available
    ? { available: true, device_id: target.deviceId, device_name: target.deviceName }
    : {
        available: false,
        reason: target.reason,
        device_id: target.deviceId,
        device_name: target.deviceName,
        message: target.message,
      };
}

/**
 * Accept the Mac app control channel and per-session relays on the backend's
 * HTTP server. `otherUpgradePaths` belong to other upgrade handlers.
 */
export function attachLocalDeviceServer(
  server: Server,
  otherUpgradePaths: readonly string[]
): void {
  localDeviceHub().attach(server, otherUpgradePaths);
}
