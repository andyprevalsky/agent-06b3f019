/** Owner device status and live screen, independent of lease custody.
 * The frame never starts/stops a session, binds a task, extends a lease or counts as activity. */
import { PhoneHarnessError, type PhoneHarnessSession } from '../../providers/phoneHarness';
import * as repo from './repo.device';
import * as commands from './repo.operations';
import { isFresh } from './service.session';
import { IPhoneError, PhoneDeviceUnavailable } from './types';
import type { PhoneClientFactory } from './types.operations';

export const deviceStatus = repo.deviceStatus;

async function currentGrant(
  snapshot: Awaited<ReturnType<typeof repo.frameSnapshot>>,
  client: ReturnType<PhoneClientFactory>
): Promise<PhoneHarnessSession> {
  if (isFresh(snapshot.session)) return snapshot.session;
  // A READY session's control grant can lapse while nobody issues commands. Read the
  // keyed receipt for the refreshed grant; never create, stop or rotate the session.
  const receipt = await client.recover(snapshot.startKey);
  const session = receipt.session;
  if (session === null || !isFresh(session))
    throw new PhoneDeviceUnavailable('STALE', 'Phone session grant has lapsed');
  await commands.saveSession(snapshot.deviceId, snapshot.startKey, session);
  return session;
}

export async function deviceFrame(userId: string, clientFactory: PhoneClientFactory) {
  const snapshot = await repo.frameSnapshot(userId);
  try {
    const client = clientFactory();
    const bytes = await client.frame(await currentGrant(snapshot, client));
    await repo.frameStillValid(snapshot);
    return bytes;
  } catch (error) {
    if (error instanceof IPhoneError) throw error;
    if (error instanceof PhoneHarnessError && error.status === 404)
      throw new PhoneDeviceUnavailable('STALE', 'Phone session receipt is unavailable');
    throw new IPhoneError(503, 'Phone view is temporarily unavailable');
  }
}
