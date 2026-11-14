/**
 * Types for the AttentionInbox component and its sub-components.
 *
 * Re-exports the canonical `AttentionRequest` shape from the feature's hooks
 * layer so sub-components import from one place.
 */

import {
  readPhoneTarget,
  readCriticalReason,
  type PhoneAttentionTarget,
  type PhoneCriticalReason,
} from '@/lib/api/phoneAttention';
import type { AttentionRequest } from '../../hooks';

export type { AttentionRequest };

/** Top-level props for the AttentionInbox component. */
export interface AttentionInboxProps {
  onSelectAgent?: (agentId: string) => void;
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
  /** Open a URL/deep-link in the OS (system browser or `roselabs://` handler). */
  openExternal?: (url: string) => Promise<void> | void;
}

/** Metadata shape for the "send via iMessage" automated action. */
export interface SendSmsMetadata {
  onSuccess: 'sendSmsThroughIMessage';
  to: string;
  message: string;
}

export interface AuthAssistanceMetadata {
  requestId: string;
  taskId?: string;
  browserSessionId?: string;
  authRealm?: string;
  mode?: string;
  steelSessionId?: string;
  liveViewUrl?: string | null;
  target?: PhoneAttentionTarget;
  criticalReason?: PhoneCriticalReason;
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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Gate object that rides on an AttentionRequest's metadata (metadata.gate). */
export interface GateMetadata {
  gateKey: string;
  type: string;
  presentation: { title: string; reason: string; cta: string };
  action: { kind: 'link'; url: string } | { kind: 'reply'; tokens: string[] };
}

/** Extract a Gate from an AttentionRequest's metadata, if present. */
export function getGateMetadata(metadata: AttentionRequest['metadata']): GateMetadata | null {
  const record = readRecord(metadata);
  if (!record) return null;
  const gate = record.gate;
  if (gate !== null && typeof gate === 'object' && 'presentation' in gate && 'action' in gate) {
    return gate as GateMetadata;
  }
  return null;
}

export function getAuthAssistanceMetadata(
  request: AttentionRequest,
): AuthAssistanceMetadata | null {
  const metadata = readRecord(request.metadata);
  if (!metadata) return null;

  const authAssistance = readRecord(metadata.authAssistance);
  const requestUserAuthentication = readRecord(metadata.requestUserAuthentication);
  const source =
    metadata.attentionKind === 'auth_assistance'
      ? (authAssistance ?? requestUserAuthentication ?? metadata)
      : (authAssistance ?? requestUserAuthentication);
  if (!source) return null;

  const requestId =
    readString(source, 'requestId') ?? readString(source, 'request_id') ?? request.id;
  const liveViewUrl = readString(source, 'liveViewUrl') ?? readString(source, 'live_view_url');

  return {
    requestId,
    taskId: readString(source, 'taskId') ?? readString(source, 'task_id'),
    browserSessionId:
      readString(source, 'browserSessionId') ?? readString(source, 'browser_session_id'),
    authRealm: readString(source, 'authRealm') ?? readString(source, 'auth_realm'),
    mode: readString(source, 'mode') ?? readString(source, 'handoffMode'),
    steelSessionId: readString(source, 'steelSessionId') ?? readString(source, 'steel_session_id'),
    liveViewUrl: liveViewUrl ?? null,
    target: readPhoneTarget(source.target),
    criticalReason: readCriticalReason(source.criticalReason),
  };
}
