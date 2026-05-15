/**
 * Types for the AttentionInbox component and its sub-components.
 *
 * Re-exports the canonical `AttentionRequest` shape from the feature's hooks
 * layer so sub-components import from one place.
 */

import type { AttentionRequest } from '../../hooks';

export type { AttentionRequest };

/** Top-level props for the AttentionInbox component. */
export interface AttentionInboxProps {
  onSelectAgent?: (agentId: string) => void;
  realtimeReady?: boolean;
}

/**
 * Shape of the Mac-app IPC bridge exposed on `window.api` when the Electron
 * preload script is active. `undefined` in the browser build.
 */
export interface MacAppBridge {
  sendIMessage?: (args: { to: string; message: string }) => Promise<{
    success?: boolean;
    message?: string;
  }>;
}

/** Metadata shape for the "send via iMessage" automated action. */
export interface SendSmsMetadata {
  onSuccess: 'sendSmsThroughIMessage';
  to: string;
  message: string;
}

/**
 * Narrow a request's metadata field to the iMessage-send variant when
 * `onSuccess === 'sendSmsThroughIMessage'` and `to`/`message` are present.
 */
export function getSendSmsMetadata(metadata: AttentionRequest['metadata']): SendSmsMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const onSuccess = (metadata as Record<string, unknown>).onSuccess;
  const to = (metadata as Record<string, unknown>).to;
  const message = (metadata as Record<string, unknown>).message;
  if (
    onSuccess === 'sendSmsThroughIMessage' &&
    typeof to === 'string' &&
    typeof message === 'string'
  ) {
    return { onSuccess, to, message };
  }
  return null;
}
