/** Browser agent -> durable device FIFO -> provider cleanup -> account iPhone. */
import * as repo from './repo';
import { cleanupPhoneIfConfigured, defaultPhoneClient } from './service.operations';
import type { PhoneActor, PhoneClientFactory } from './types.operations';
import {
  IPhoneError,
  type AcquireInput,
  type ActionInput,
  type IPhoneLease,
  type LeaseAction,
} from './types';

export async function capability(userId: string) {
  const device = await repo.capabilityData(userId);
  return {
    enabled: device?.enabled === true,
    configured: device !== null,
    setupState: device?.setupState ?? null,
  };
}
export async function bind(userId: string, providerDeviceId: string) {
  await repo.bind(userId, providerDeviceId);
  return capability(userId);
}
export async function acquire(
  userId: string,
  input: AcquireInput,
  clientFactory = defaultPhoneClient
) {
  const phone = await cleanupPhoneIfConfigured(userId, clientFactory);
  const result = await repo.transaction(async (tx) => {
    if (!(await repo.accountPermitted(tx, userId)))
      return new IPhoneError(403, 'iPhone access denied');
    const { device, enabled } = await repo.lockedDevice(tx, userId);
    if (!enabled) return new IPhoneError(403, 'iPhone device is disabled');
    const id = await repo.enqueue(tx, device, input);
    await repo.admit(tx, device.id);
    return id instanceof IPhoneError ? id : repo.view(tx, id);
  });
  if (result instanceof IPhoneError) throw result;
  return { ...present(result), ...(phone === null ? {} : { phone }) };
}
export async function act(
  userId: string,
  id: string,
  action: LeaseAction,
  input: ActionInput,
  clientFactory: PhoneClientFactory = defaultPhoneClient,
  actor: PhoneActor = 'agent'
) {
  await repo.requireOwnedLease(userId, id);
  await cleanupPhoneIfConfigured(userId, clientFactory);
  const result = await repo.transaction(async (tx) => {
    if ((await repo.readLease(tx, id, userId)) === null)
      return new IPhoneError(404, 'Lease not found');
    const { device, enabled } = await repo.lockedDevice(tx, userId);
    if (!enabled && action !== 'release' && action !== 'read')
      return new IPhoneError(403, 'iPhone device is disabled');
    const lease = await repo.readLease(tx, id, userId);
    if (lease === null) return new IPhoneError(404, 'Lease not found');
    const error = await repo.mutate(tx, lease, action, input, await repo.databaseNow(tx), actor);
    if (enabled) await repo.admit(tx, device.id);
    return error ?? repo.view(tx, id);
  });
  // Reconciliation must commit even when a stale operation returns an error.
  if (result instanceof IPhoneError) throw result;
  const phone = await cleanupPhoneIfConfigured(userId, clientFactory);
  if (phone?.state === 'cleanup_complete') {
    const refreshed = await repo.transaction(async (tx) => {
      const { device, enabled } = await repo.lockedDevice(tx, userId);
      if (enabled) await repo.admit(tx, device.id);
      return repo.view(tx, id);
    });
    return { ...present(refreshed), phone };
  }
  return { ...present(result), ...(phone === null ? {} : { phone }) };
}

export function present({
  lease,
  queuePosition,
  setup,
}: {
  lease: IPhoneLease;
  queuePosition: number | null;
  setup?: unknown;
}) {
  return {
    ...(setup === undefined ? {} : { setup }),
    lease: {
      id: lease.id,
      agentId: lease.agentId,
      browserTaskId: lease.browserTaskId,
      status: lease.status,
      queuePosition,
      queueDeadlineAt: lease.queueDeadlineAt,
      leaseExpiresAt: lease.leaseExpiresAt,
      controlOwner: lease.controlOwner,
      attentionRequestId: lease.attentionRequestId,
      revision: lease.revision,
    },
  };
}
