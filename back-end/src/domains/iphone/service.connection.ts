/** Normal connection uses an existing bound device and one normal owned setup root. */
import * as repo from './repo.connection';
import type { PhoneConnectionReservation } from '../../providers/phoneConnectionState';

export type SetupAgentLauncher = (
  userId: string,
  deviceId: string,
  reservation: PhoneConnectionReservation
) => Promise<void>;
export const connection = repo.connection;
export async function connect(
  userId: string,
  expectedRevision: number,
  requestKey: string,
  launch: SetupAgentLauncher
) {
  const reserved = await repo.reserve(userId, expectedRevision, requestKey);
  if (reserved.reservation) {
    await launch(userId, reserved.deviceId, reserved.reservation);
    await repo.recordSetupStart(userId, reserved.reservation);
  }
  return repo.connection(userId);
}

export { availability } from './repo.availability';
