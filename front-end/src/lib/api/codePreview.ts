/**
 * Code-session preview REST client (Rose Desktop full-screen app view, opened
 * from a code-agent chip's live preview card). Backend contract:
 * feat/rose-user-ui @ 7826a2a6b (A1 Rose-in-Rose) plus the pending L-APPS2
 * preview sign-in handoff.
 *
 *   GET  /api/claude-code-session/:taskId/preview -> CodePreviewView
 *        403 ROSE_DEV_ONLY · 404 CODE_TASK_NOT_FOUND
 *   POST /api/claude-code-session/:taskId/preview/handoff -> { code, expires_at }
 *        (L-APPS2: 60 s, single-use sign-in code for the preview origin)
 *   POST /api/claude-code-session/:taskId/publish {} -> CodePublishResult
 *        (pushes the branch and opens a PR; never merges or deploys)
 *        409 NOT_A_GITHUB_REPO | NO_CODE_SESSION | SESSION_RETIRED | NO_BRANCH |
 *            ON_MERGE_TARGET | NO_COMMITS | UNSUPPORTED_TARGET
 *        502 PUSH_FAILED | PR_CREATE_FAILED | GITHUB_UNAVAILABLE
 *
 * Every failure throws CodePreviewApiError carrying the HTTP status and the
 * backend's `code`, so callers can render ROSE_DEV_ONLY as nothing at all.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export type CodePreviewStatus = 'running' | 'not_running' | 'paused' | 'unknown';

export interface CodePreviewView {
  task_id: string;
  code_session_id: string | null;
  target: 'cloud' | 'local';
  preview_url: string | null;
  port: number | null;
  status: CodePreviewStatus;
  checked_at: string;
}

export interface CodePreviewHandoff {
  code: string;
  expires_at: string;
}

export interface CodePublishResult {
  code_session_id: string;
  repo: string;
  branch: string;
  base: string;
  head_sha: string;
  pushed: boolean;
  pr: { number: number; url: string; state: string; draft: boolean };
  /** false = the branch already had an open PR (it was updated by the push). */
  created: boolean;
  merged: boolean;
}

export const ROSE_DEV_ONLY = 'ROSE_DEV_ONLY';

export class CodePreviewApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'CodePreviewApiError';
  }
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${API_BASE_WITH_PATH}${path}`, {
    ...init,
    headers: getAuthHeaders(),
  });
  if (!response.ok) {
    const body = rec(await response.json().catch(() => null));
    throw new CodePreviewApiError(
      response.status,
      str(body?.code),
      str(body?.error) ?? `Request failed (${response.status})`,
    );
  }
  return response.json().catch(() => null);
}

const taskPath = (taskId: string, rest: string) =>
  `/claude-code-session/${encodeURIComponent(taskId)}/${rest}`;

export async function fetchCodePreview(taskId: string): Promise<CodePreviewView> {
  return (await request(taskPath(taskId, 'preview'))) as CodePreviewView;
}

/** A fresh single-use sign-in code for the preview origin (one per frame load). */
export async function createPreviewHandoff(taskId: string): Promise<CodePreviewHandoff> {
  const body = rec(
    await request(taskPath(taskId, 'preview/handoff'), { method: 'POST', body: '{}' }),
  );
  const code = str(body?.code);
  if (!code) throw new CodePreviewApiError(502, null, 'Handoff returned no code');
  return { code, expires_at: str(body?.expires_at) ?? '' };
}

/** Push the session's branch and open (or update) its PR. Never merges or deploys. */
export async function publishCodeSession(taskId: string): Promise<CodePublishResult> {
  return (await request(taskPath(taskId, 'publish'), {
    method: 'POST',
    body: '{}',
  })) as CodePublishResult;
}
