/**
 * IPC wrappers for the update-indicator feature — the sole consumer of the
 * `window.api` update surface. Hooks call these; components never touch
 * `window.api` directly.
 */

import type { UpdateStatusPayload } from './types';
import { getElectronApi } from '../../lib/electron-api';

export const subscribeToUpdateStatus = (callback: (payload: UpdateStatusPayload) => void): void => {
  getElectronApi()?.onUpdateStatus(callback);
};

export const subscribeToUpdateProgress = (callback: (percent: number) => void): void => {
  getElectronApi()?.onUpdateProgress(callback);
};

export const downloadUpdate = (): Promise<{ success: boolean }> =>
  getElectronApi()?.downloadUpdate() ?? Promise.resolve({ success: false });

export const restartToUpdate = (): Promise<{ success: boolean }> =>
  getElectronApi()?.restartToUpdate() ?? Promise.resolve({ success: false });

export const checkForUpdates = (): Promise<{ success: boolean }> =>
  getElectronApi()?.checkForUpdates() ?? Promise.resolve({ success: false });
