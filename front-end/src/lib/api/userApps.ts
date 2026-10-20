/**
 * Apps REST client (Rose Desktop left-bar Apps section + full-screen app view).
 * Backend contract: feat/rose-user-ui @ 7826a2a6b (A1 Rose-in-Rose, A2 Apps) plus
 * the pending L-APPS2 additions (preview handoff, task ids on user app rows).
 *
 *   GET  /api/user-ui/apps                      -> { activeVersionId, apps: UserAppEntry[] }
 *        Rose first for dev accounts only; then the active version's apps.
 *   GET  /api/user-ui/versions                  -> { activeVersionId, versions: [{ versionId,
 *        manifest (lists its apps), fileCount, totalBytes, createdAt, active }] }
 *   POST /api/user-ui/versions/:id/activate     -> { versionId, active: true } (restore)
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
 * Every failure throws UserAppsApiError carrying the HTTP status and the
 * backend's `code`, so callers can render ROSE_DEV_ONLY as nothing at all.
 */

import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

/** The built-in Rose app (dev accounts only). Publish opens a pull request. */
export interface BuiltinUserApp {
  id: 'rose';
  kind: 'builtin';
  title: string;
  url: null;
  /** Live HMR preview of the newest Rose-repo code session, when one exists. */
  preview_url: string | null;
  task_id: string | null;
  code_session_id: string | null;
  publish: 'pull_request';
}

/** A published app of the active rose_user_ui version (usercontent origin). */
export interface PublishedUserApp {
  id: string;
  kind: 'user';
  title: string;
  /** Per-user usercontent URL of this version's entry. */
  url: string;
  icon_url: string | null;
  version_id: string;
  /** L-APPS2: the code agent that last published it (null on older versions). */
  task_id: string | null;
  code_session_id: string | null;
  publish: 'usercontent';
}

export type UserAppEntry = BuiltinUserApp | PublishedUserApp;

export interface UserAppsResponse {
  activeVersionId: string | null;
  apps: UserAppEntry[];
}

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

/** One app listed in a version's manifest. */
export interface UserUiVersionApp {
  title: string;
  entry: string;
  icon?: string;
}

export interface UserUiVersionWithApps {
  versionId: string;
  createdAt: string | null;
  fileCount: number | null;
  active: boolean;
  apps: Record<string, UserUiVersionApp>;
}

export const ROSE_DEV_ONLY = 'ROSE_DEV_ONLY';

export class UserAppsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'UserAppsApiError';
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
    throw new UserAppsApiError(
      response.status,
      str(body?.code),
      str(body?.error) ?? `Request failed (${response.status})`,
    );
  }
  return response.json().catch(() => null);
}

function parseApp(value: unknown): UserAppEntry | null {
  const r = rec(value);
  const id = str(r?.id);
  const title = str(r?.title);
  if (!r || !id || !title) return null;
  const taskId = str(r.task_id);
  const codeSessionId = str(r.code_session_id);
  if (r.kind === 'builtin' && id === 'rose') {
    return {
      id: 'rose',
      kind: 'builtin',
      title,
      url: null,
      preview_url: str(r.preview_url),
      task_id: taskId,
      code_session_id: codeSessionId,
      publish: 'pull_request',
    };
  }
  const url = str(r.url);
  const versionId = str(r.version_id);
  if (r.kind !== 'user' || !url || !versionId) return null;
  return {
    id,
    kind: 'user',
    title,
    url,
    icon_url: str(r.icon_url),
    version_id: versionId,
    task_id: taskId,
    code_session_id: codeSessionId,
    publish: 'usercontent',
  };
}

export async function fetchUserApps(): Promise<UserAppsResponse> {
  const body = rec(await request('/user-ui/apps'));
  const apps = Array.isArray(body?.apps) ? body.apps : [];
  return {
    activeVersionId: str(body?.activeVersionId),
    apps: apps.map(parseApp).filter((app): app is UserAppEntry => app !== null),
  };
}

function parseVersionApps(manifest: unknown): Record<string, UserUiVersionApp> {
  const apps = rec(rec(manifest)?.apps);
  const out: Record<string, UserUiVersionApp> = {};
  for (const [slug, value] of Object.entries(apps ?? {})) {
    const app = rec(value);
    const title = str(app?.title);
    const entry = str(app?.entry);
    const icon = str(app?.icon);
    if (title && entry) out[slug] = icon ? { title, entry, icon } : { title, entry };
  }
  return out;
}

/** Published versions, newest first as the backend lists them. */
export async function fetchUserUiVersionsWithApps(): Promise<UserUiVersionWithApps[]> {
  const body = rec(await request('/user-ui/versions'));
  const list = Array.isArray(body?.versions) ? body.versions : [];
  return list.flatMap((item) => {
    const r = rec(item);
    const versionId = str(r?.versionId);
    if (!r || !versionId) return [];
    return [
      {
        versionId,
        createdAt: str(r.createdAt),
        fileCount: typeof r.fileCount === 'number' ? r.fileCount : null,
        active: r.active === true,
        apps: parseVersionApps(r.manifest),
      },
    ];
  });
}

/** One-click restore: make an older published version the active one. */
export async function activateUserUiVersion(versionId: string): Promise<void> {
  await request(`/user-ui/versions/${encodeURIComponent(versionId)}/activate`, { method: 'POST' });
}

export async function fetchCodePreview(taskId: string): Promise<CodePreviewView> {
  return (await request(
    `/claude-code-session/${encodeURIComponent(taskId)}/preview`,
  )) as CodePreviewView;
}

/** A fresh single-use sign-in code for the preview origin (one per frame load). */
export async function createPreviewHandoff(taskId: string): Promise<CodePreviewHandoff> {
  const body = rec(
    await request(`/claude-code-session/${encodeURIComponent(taskId)}/preview/handoff`, {
      method: 'POST',
      body: '{}',
    }),
  );
  const code = str(body?.code);
  if (!code) throw new UserAppsApiError(502, null, 'Handoff returned no code');
  return { code, expires_at: str(body?.expires_at) ?? '' };
}

/** Push the session's branch and open (or update) its PR. Never merges or deploys. */
export async function publishCodeSession(taskId: string): Promise<CodePublishResult> {
  return (await request(`/claude-code-session/${encodeURIComponent(taskId)}/publish`, {
    method: 'POST',
    body: '{}',
  })) as CodePublishResult;
}
