/**
 * IPC wrappers for the update-indicator feature — the sole consumer of the
 * `window.api` update surface. Hooks call these; components never touch
 * `window.api` directly.
 */

import type { UpdateStatusPayload } from './types';

export const subscribeToUpdateStatus = (callback: (payload: UpdateStatusPayload) => void): void => {
  window.api.onUpdateStatus(callback);
};

export const subscribeToUpdateProgress = (callback: (percent: number) => void): void => {
  window.api.onUpdateProgress(callback);
};

export const downloadUpdate = (): Promise<{ success: boolean }> => window.api.downloadUpdate();

export const restartToUpdate = (): Promise<{ success: boolean }> => window.api.restartToUpdate();

export const checkForUpdates = (): Promise<{ success: boolean }> => window.api.checkForUpdates();
