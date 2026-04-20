import type { UpdateStatusPayload } from '../../../shared/types/ipc';

export type { UpdateStatusPayload };

/**
 * Result of the `useUpdateIndicator` hook — all state needed by
 * `components/UpdateIndicator.tsx` to render the chip in its current state.
 */
export interface UseUpdateIndicatorResult {
  status: UpdateStatusPayload;
  progress: number;
  showNoneChip: boolean;
  container: HTMLElement;
  dismiss: () => void;
  isDismissedVersion: boolean;
  onInstallNow: () => void;
  onRestartNow: () => void;
  onRetry: () => void;
}
