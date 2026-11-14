/**
 * API layer for the terminal-component-group domain.
 *
 * Re-exports API functions consumed by terminal UI components. Components import
 * from this file instead of reaching into shared/lib directly. This establishes
 * the API boundary so cross-cutting changes to the client are isolated here.
 */

import { benchmarkAgentPreviewEnabled } from '@/lib/api/agents';
import { getSession, getStoredSession, supabase } from '@/lib/supabase';
import { getAuthHeaders } from '@/lib/api/client';
import { API_URL, API_BASE_WITH_PATH } from './config';
import type { CodeProvider, UsageData } from './types';

export interface ClaudeCodeSessionResponse {
  output?: string;
  status?: string;
  closed_at?: string | null;
}

/**
 * Fetch the saved terminal output for a code-agent session. Best-effort:
 * returns null on any failure (auth missing, network, non-OK response).
 */
async function fetchBenchmarkCodeAgentSessionPreview(
  taskId: string,
  codeProvider: CodeProvider,
): Promise<ClaudeCodeSessionResponse | null> {
  if (!benchmarkAgentPreviewEnabled() || codeProvider !== 'claude') return null;

  const response = await fetch(
    `${API_BASE_WITH_PATH}/benchmarks/claude-code-session-preview/${taskId}`,
  );
  if (!response.ok) return null;
  return (await response.json()) as ClaudeCodeSessionResponse;
}

export async function fetchCodeAgentSession(
  taskId: string,
  codeProvider: CodeProvider = 'claude',
): Promise<ClaudeCodeSessionResponse | null> {
  try {
    const token = getSession()?.access_token;
    if (!token) {
      return fetchBenchmarkCodeAgentSessionPreview(taskId, codeProvider);
    }

    const sessionPath = codeProvider === 'codex' ? 'codex-code-session' : 'claude-code-session';
    const response = await fetch(`${API_URL}/api/${sessionPath}/${taskId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return fetchBenchmarkCodeAgentSessionPreview(taskId, codeProvider);
    }
    return (await response.json()) as ClaudeCodeSessionResponse;
  } catch {
    return fetchBenchmarkCodeAgentSessionPreview(taskId, codeProvider);
  }
}

/** Backward-compatible helper for callers that only know about Claude sessions. */
export async function fetchClaudeCodeSession(
  taskId: string,
): Promise<ClaudeCodeSessionResponse | null> {
  return fetchCodeAgentSession(taskId, 'claude');
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
export async function downloadAttachmentAsBlob(
  url: string,
  options?: { signal?: AbortSignal },
): Promise<Blob> {
  const response = await fetch(url, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to download attachment (status ${response.status})`);
  }
  return response.blob();
}

/** Download a signed text attachment body for inline preview rendering. */
export async function downloadAttachmentAsText(
  url: string,
  options?: { signal?: AbortSignal },
): Promise<string> {
  const response = await fetch(url, { signal: options?.signal });
  if (!response.ok) {
    throw new Error(`Failed to download attachment (status ${response.status})`);
  }
  return response.text();
}

/** Fetch first-party phone-call recording bytes for FE playback. */
export async function fetchPhoneCallRecording(
  agentId: string,
  callId: string,
  options?: { signal?: AbortSignal },
): Promise<Blob> {
  const response = await fetch(
    `${API_BASE_WITH_PATH}/agents/${encodeURIComponent(agentId)}/phone-calls/${encodeURIComponent(callId)}/recording`,
    { headers: getAuthHeaders(), signal: options?.signal },
  );
  if (!response.ok) {
    throw new Error(`Failed to load phone recording (${response.status})`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    throw new Error(`Phone recording response was not audio (${contentType || 'unknown'})`);
  }
  return response.blob();
}

const SIGNED_ATTACHMENT_URL_TTL_SECONDS = 3600;

/** Create a time-limited download/preview URL for a stored attachment. */
export async function createAttachmentSignedUrl(storagePath: string): Promise<string | null> {
  const { data } = await supabase.storage
    .from('attachments')
    .createSignedUrl(storagePath, SIGNED_ATTACHMENT_URL_TTL_SECONDS);
  return data?.signedUrl ?? null;
}

export interface CatalogTestPrompt {
  title: string;
  description: string;
  prompt: string;
  attachmentUrls: string[];
  /** Catalog tags — optional so an older backend payload without tags still parses. */
  tags?: string[];
  /** Optional so an older backend without the last-5 signal still parses. */
  lastFivePassed?: boolean;
}

/**
 * Fetch the test-prompt catalog from the backend.
 *
 * The backend adapts `agents/benchmarks/tasks.json` (the single canonical eval
 * catalog) via GET /api/benchmarks/test-prompts, so the dev query box and the
 * benchmark suite can never drift apart. Throws on non-OK responses.
 */
export async function fetchTestPromptCatalog(): Promise<CatalogTestPrompt[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/benchmarks/test-prompts`);
  if (!response.ok) {
    throw new Error(`test-prompts fetch failed: ${response.status}`);
  }
  const data = (await response.json()) as { prompts?: CatalogTestPrompt[] };
  if (!Array.isArray(data.prompts)) {
    throw new Error('test-prompts fetch failed: malformed catalog response');
  }
  return data.prompts;
}

/**
 * Fetch this backend's live ngrok public URL for the test-payment page,
 * or null when no tunnel is up. Used to resolve the {{TEST_PAYMENT_BASE_URL}}
 * token in catalog prompts so the cloud browser agent gets a reachable URL.
 */
export async function fetchTestPaymentPublicUrl(): Promise<string | null> {
  try {
    const response = await fetch(`${API_URL}/api/test-payment/public-url`);
    if (!response.ok) return null;
    const data = (await response.json()) as { url: string | null };
    return data.url ?? null;
  } catch {
    return null;
  }
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

/** One repo from the user's connected GitHub repo inventory (GET /api/integrations/github/repos). */
export interface ConnectedGithubRepo {
  canonical_ref: string; // gh:<owner>/<repo>, lowercased
  repo_name: string;
  repo_url: string;
  owner: string;
  default_branch: string | null;
  connected_rose_project_ref: string | null;
}

/** The user's connected GitHub repos, the options a new code agent can select. Throws on non-OK. */
export async function fetchConnectedGithubRepos(): Promise<ConnectedGithubRepo[]> {
  const response = await fetch(`${API_BASE_WITH_PATH}/integrations/github/repos`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Failed to load connected GitHub repos');
  const data = (await response.json()) as { repos?: ConnectedGithubRepo[] };
  return data.repos ?? [];
}

export {
  respondToAttentionRequest,
  completeAuthAssistanceRequest,
  refreshAuthAssistanceSession,
  rejectAttentionRequest,
  skipAttentionRequest,
  getAttentionRequests,
  updateAgent,
  deleteAgent,
  archiveAgent,
  unarchiveAgent,
  getArchivedAgents,
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
  reportAgentBug,
  uploadBugReportScreenshot,
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
  ReportAgentBugResult,
} from '@/lib/api';

export { subscribeToAttentionRequests, unsubscribe } from '@/lib/realtime';
export type { FailureContext } from '@/lib/realtime';
export type { PlanTask } from '@/lib/realtime-types';

export { getStoredSession } from '@/lib/supabase';
