/**
 * Shared types for the BrowserStatusBar sub-components.
 *
 * Keeps BrowserStatusBar.tsx under the 300-line cap by isolating prop
 * contracts and derived view-model shapes in one place.
 */

import type { Message, ResponseSchemaField } from '../../hooks';

/** Public props for the BrowserStatusBar component. */
export interface BrowserStatusBarProps {
  taskId: string;
  browserUrl: string;
  forceMinimized?: boolean;
}

/** Output schema payload carried on the init message's metadata. */
export interface OutputSchemaRef {
  fields: ResponseSchemaField[];
}

/** Step progress derived from the latest browser step message. */
export interface StepProgress {
  stepsTaken: number;
  totalSteps: number;
}

/** Pending write-lock approval extracted from the message list. */
export interface PendingWriteLockApproval {
  attentionRequestId: string;
  question: string;
}

/** Full view-model surfaced by the useBrowserStatusBarState hook. */
export interface BrowserStatusBarViewModel {
  browserMessages: Message[];
  lastActionType: string | undefined;
  lastActionTitle: string;
  isDisconnected: boolean;
  outputSchema: OutputSchemaRef | undefined;
  stepProgress: StepProgress | null;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
}
