/**
 * i-message-sync — local run state per (user, Mac).
 *
 *   readStateFile ─► users[userId] ─► same Mac id? keep : fresh state
 *   every batch   ─► saveUserState (atomic file replace)
 */

import { readStateFile, writeStateFile } from './repo';
import type { DeviceSyncState, SyncStateFile } from './types';

export interface UserStateHandle {
  file: SyncStateFile;
  userId: string;
  state: DeviceSyncState;
}

function freshState(accountId: string): DeviceSyncState {
  return { accountId, established: false, removed: false, lastCompletedRowId: 0, run: null };
}

/** This user's state on this Mac; a different device id starts over. */
export function loadUserState(userId: string, accountId: string): UserStateHandle {
  const file = readStateFile();
  const stored = file.users[userId];
  const state =
    stored !== undefined && stored.accountId === accountId ? stored : freshState(accountId);
  return { file, userId, state };
}

export function saveUserState(handle: UserStateHandle): void {
  handle.file.users[handle.userId] = handle.state;
  writeStateFile(handle.file);
}

/** The backend no longer has this Mac's account: forget the cursor, wait for a reconnect. */
export function markAccountRemoved(handle: UserStateHandle): void {
  handle.state = { ...freshState(handle.state.accountId), removed: true };
  saveUserState(handle);
}
