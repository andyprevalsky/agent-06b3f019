/** Authenticate browser scope before cleanup; expose safe durable observations only. */
import * as repo from './repo.interactions';
import { IPhoneError } from './types';
import { present } from './service';
import {
  publicOperation,
  cleanupPhoneIfConfigured,
  defaultPhoneClient,
} from './service.operations';
import type { PhoneClientFactory } from './types.operations';

async function presentInteraction(result: Awaited<ReturnType<typeof repo.readInteraction>>) {
  if (result instanceof IPhoneError) throw result;
  if (result === null)
    return {
      lease: null,
      holder: null,
      queuePosition: null,
      cursor: 0,
      lastOperation: null,
      pendingOperation: null,
    };
  return {
    ...present(result),
    cursor: result.lease.actionCursor,
    lastOperation:
      result.lastOperation === null ? null : await publicOperation(result.lastOperation),
    pendingOperation:
      result.pendingOperation === null ? null : await publicOperation(result.pendingOperation),
  };
}

export async function interaction(
  userId: string,
  taskId: string,
  requestKey?: string,
  clientFactory: PhoneClientFactory = defaultPhoneClient
) {
  const task = await repo.requireBrowserTask(userId, taskId);
  if (requestKey === undefined && !(await repo.hasInteraction(task.deviceId, taskId)))
    return presentInteraction(null);
  await cleanupPhoneIfConfigured(userId, clientFactory);
  const result =
    requestKey === undefined
      ? await repo.readInteraction(userId, taskId)
      : await repo.ensureInteraction(userId, taskId, task.agentId, requestKey);
  return presentInteraction(result);
}
