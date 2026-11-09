/**
 * Shared types for the BrowserStatusBar sub-components.
 *
 * Keeps BrowserStatusBar.tsx under the 300-line cap by isolating prop
 * contracts and derived view-model shapes in one place.
 */

import type { PhoneAttentionTarget, PhoneCriticalReason } from '@/lib/api/phoneAttention';
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

/** Pending auth-assistance live browser handoff extracted from the message list. */
export interface PendingAuthAssistance {
  requestId: string;
  authRealm?: string;
  request: string;
  liveViewUrl?: string;
  target?: PhoneAttentionTarget;
  criticalReason?: PhoneCriticalReason;
}

/** Browser provider/proxy metadata surfaced by browser-session init/resume. */
export interface BrowserSessionMetadata {
  provider?: string;
  proxy_source?: string;
  proxySource?: string;
  proxy_location?: BrowserProxyLocation;
  proxyLocation?: BrowserProxyLocation;
}

export interface BrowserProxyLocation {
  city?: string;
  state?: string;
  country?: string;
}

/** Full view-model surfaced by the useBrowserStatusBarState hook. */
export interface BrowserStatusBarViewModel {
  readOnly: boolean;
  browserMessages: Message[];
  lastActionType: string | undefined;
  lastActionTitle: string;
  isDisconnected: boolean;
  outputSchema: OutputSchemaRef | undefined;
  browserSessionMetadata: BrowserSessionMetadata | null;
  stepProgress: StepProgress | null;
  pendingWriteLockApproval: PendingWriteLockApproval | null;
  pendingAuthAssistance: PendingAuthAssistance | null;
}
