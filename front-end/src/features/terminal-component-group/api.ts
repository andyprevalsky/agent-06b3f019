/**
 * API layer for the terminal-component-group domain.
 *
 * Re-exports API functions consumed by terminal UI components. Components import
 * from this file instead of reaching into shared/lib directly. This establishes
 * the API boundary so cross-cutting changes to the client are isolated here.
 */

import { getSession, getStoredSession } from '@/lib/supabase';
import { API_URL, API_BASE_WITH_PATH } from './config';
import type { UsageData } from './types';

export interface ClaudeCodeSessionResponse {
  output?: string;
}

/**
 * Fetch the saved terminal output for a Claude Code session. Best-effort:
 * returns null on any failure (auth missing, network, non-OK response).
 */
export async function fetchClaudeCodeSession(
  taskId: string,
): Promise<ClaudeCodeSessionResponse | null> {
  try {
    const token = getSession()?.access_token;
    if (!token) return null;

    const response = await fetch(`${API_URL}/api/claude-code-session/${taskId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) return null;
    return (await response.json()) as ClaudeCodeSessionResponse;
  } catch {
    return null;
  }
}

/** Fetch current credits usage for the authenticated user. Returns null when not authenticated or on error. */
export async function fetchCreditsUsage(): Promise<UsageData | null> {
  const session = getStoredSession();
  if (!session) return null;

  const response = await fetch(`${API_BASE_WITH_PATH}/credits/usage`, {
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) return null;
  return (await response.json()) as UsageData;
}

/**
 * Fetch a file served from the Vite `public/` folder (e.g. `/test-assets/*`) as a Blob.
 *
 * Handles the Electron `file://` protocol by stripping the leading slash, and treats
 * an HTML response as a missing asset (dev server falling back to `index.html`).
 * Returns `null` when the asset is missing or the server replied with a non-OK / HTML body.
 */
export async function fetchPublicAsset(
  assetPath: string,
): Promise<{ blob: Blob; filename: string } | null> {
  const isFileProtocol = window.location.protocol === 'file:';
  const url = isFileProtocol ? assetPath.replace(/^\//, '') : assetPath;

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Test asset ${url} failed: ${response.status} ${response.statusText}`);
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    console.error(`Test asset ${url} returned HTML — file missing from public/ folder`);
    return null;
  }

  const blob = await response.blob();
  const filename = url.split('/').pop() ?? 'attachment';
  return { blob, filename };
}

/**
 * Download the bytes behind a signed attachment URL as a Blob.
 *
 * Cross-origin URLs ignore the HTML `download` attribute, so MessageBubble's
 * AttachmentDisplay needs to fetch the file as a blob and create a blob URL
 * to force a real download. Centralizing the fetch here keeps domain
 * components compliant with the strict lint no-direct-fetch rule.
 */
export async function downloadAttachmentAsBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download attachment (status ${response.status})`);
  }
  return response.blob();
}

/** Submit free-form feedback text for the authenticated user. Throws when unauthenticated or on non-OK. */
export async function submitFeedback(feedback: string): Promise<void> {
  const session = getStoredSession();
  if (!session) throw new Error('Not authenticated');

  const response = await fetch(`${API_BASE_WITH_PATH}/feedback`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ feedback }),
  });

  if (!response.ok) {
    throw new Error('Failed to submit');
  }
}

export {
  respondToAttentionRequest,
  rejectAttentionRequest,
  skipAttentionRequest,
  getAttentionRequests,
  updateAgent,
  deleteAgent,
  postMessage,
  startAgent,
  signalSignupCompleted,
  signalSignupDismissed,
  getPeople,
  getTools,
  generateLLMJudgePrompt,
  getAttachmentUrl,
  uploadAttachment,
  resumeBrowserSession,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from '@/lib/api';

export type {
  Agent,
  AgentDetail,
  AttentionRequest,
  Message,
  FilePointer,
  OutputSchema,
  OutputSchemaField,
  ResponseSchemaField,
  Tool,
  PeoplePaginatedResponse,
  Person,
} from '@/lib/api';

export { subscribeToAttentionRequests, unsubscribe } from '@/lib/realtime';
export type { FailureContext } from '@/lib/realtime';
export type { PlanTask } from '@/lib/realtime-types';

export { getStoredSession } from '@/lib/supabase';
