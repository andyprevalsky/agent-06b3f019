/**
 * Launch a Cursor cloud agent via GitHub `@cursor` mention (source:scm).
 *
 * Cursor hides source:api chats by default in Filter → Source (web + mobile).
 * GitHub-triggered agents are stamped source:scm and appear in the default
 * interactive inbox — including the Cursor iOS mobile dashboard.
 *
 * Docs / Cursor staff:
 * https://forum.cursor.com/t/cursor-cloud-agent-filtering-is-very-confusing/167363
 */

import { createLogger } from './logger';

const log = createLogger('CursorGithubLaunch');

const AGENT_URL_RE = /https:\/\/cursor\.com\/agents\/(bc-[a-zA-Z0-9-]+)/i;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 45_000;

export interface LaunchCursorViaGithubInput {
  name: string;
  promptText: string;
  /** owner/repo, e.g. Rose-Ai-Labs/rose */
  repo: string;
  /** Optional override for tests */
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Injected fetch for unit tests */
  fetchImpl?: typeof fetch;
  /** Injected clock for unit tests */
  sleep?: (ms: number) => Promise<void>;
}

export interface LaunchedCursorViaGithub {
  id: string;
  name: string;
  url: string;
  status: string;
  github_issue_url: string;
  github_issue_number: number;
  launch_source: 'scm';
}

function githubTokens(): string[] {
  // Prefer GITHUB_DISPATCH_TOKEN — GITHUB_TOKEN is often a stale/expired PAT in
  // this stack (same prod failure mode as admin-health velocity / create-repo).
  return [
    ...new Set(
      [process.env.GITHUB_DISPATCH_TOKEN ?? '', process.env.GITHUB_TOKEN ?? '']
        .map((t) => t.trim())
        .filter((t) => t !== '')
    ),
  ];
}

async function githubFetch(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  const tokens = githubTokens();
  if (tokens.length === 0) {
    throw new Error('GITHUB_TOKEN / GITHUB_DISPATCH_TOKEN is not configured');
  }

  let lastStatus = 0;
  let lastBody = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'rose-report-bug',
        ...(init.headers ?? {}),
      },
    });
    if (response.ok) return response;
    lastStatus = response.status;
    lastBody = (await response.text()).slice(0, 500);
    const canFallback =
      i < tokens.length - 1 && (response.status === 401 || response.status === 403);
    if (canFallback) {
      log.warn('GitHub token rejected; trying fallback', { status: response.status, path });
      continue;
    }
    throw new Error(`GitHub API ${response.status}: ${lastBody || 'request failed'}`);
  }
  throw new Error(`GitHub API ${lastStatus}: ${lastBody || 'request failed'}`);
}

/** Issue/comment body that triggers Cursor and carries the RCA prompt. */
export function buildGithubCursorIssueBody(name: string, promptText: string): string {
  // Lead with the chat title — Cursor derives the agent display name from the
  // first substantive line of the @cursor comment (verified 2026-08-29: without
  // this, scm agents were auto-named from the description and dropped "Bug |").
  return [
    '@cursor',
    '',
    name.trim(),
    '',
    promptText.trim(),
    '',
    '_Launched by Rose Report Bug (prefer source:scm so the chat shows in the Cursor mobile inbox)._',
  ].join('\n');
}

/** Extract Cursor agent id + url from a cursor[bot] comment body. */
export function parseCursorAgentFromComment(body: string): { id: string; url: string } | null {
  const match = AGENT_URL_RE.exec(body);
  if (match === null) return null;
  const id = match[1];
  return { id, url: `https://cursor.com/agents/${id}` };
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a GitHub issue titled with the chat name and @cursor in the body.
 * Poll until cursor[bot] posts the agent deep link, then close the issue.
 */
export async function launchCursorCloudAgentViaGithub(
  input: LaunchCursorViaGithubInput
): Promise<LaunchedCursorViaGithub> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = input.pollIntervalMs ?? DEFAULT_POLL_MS;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const [owner, repo] = input.repo.split('/');
  if (owner === undefined || repo === undefined || owner === '' || repo === '') {
    throw new Error(`Invalid GitHub repo: ${input.repo}`);
  }

  log.info('Launching Cursor agent via GitHub @cursor', {
    name: input.name,
    repo: input.repo,
    prompt_preview: input.promptText.slice(0, 200),
  });

  const createRes = await githubFetch(
    `/repos/${owner}/${repo}/issues`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: input.name,
        body: [
          'Rose Report Bug — launching a Cursor cloud agent via `@cursor` so the chat is `source:scm` (visible in the mobile inbox).',
          '',
          'Agent prompt follows in the next comment.',
        ].join('\n'),
      }),
    },
    fetchImpl
  );
  const issue = (await createRes.json()) as {
    number: number;
    html_url: string;
  };
  if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string') {
    throw new Error('GitHub issue create returned no number');
  }

  log.info('GitHub issue created for Cursor launch', {
    issue_number: issue.number,
    issue_url: issue.html_url,
  });

  // Cursor watches issue/PR *comments* for @cursor — body-only mentions on create
  // do not reliably start an agent (proved 2026-08-29 on issue #1108).
  await githubFetch(
    `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
    {
      method: 'POST',
      body: JSON.stringify({ body: buildGithubCursorIssueBody(input.name, input.promptText) }),
    },
    fetchImpl
  );

  const deadline = Date.now() + timeoutMs;
  let launched: { id: string; url: string } | null = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const commentsRes = await githubFetch(
      `/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=20`,
      { method: 'GET' },
      fetchImpl
    );
    const comments = (await commentsRes.json()) as Array<{
      user?: { login?: string };
      body?: string;
    }>;
    for (const comment of comments) {
      const login = comment.user?.login ?? '';
      if (!login.toLowerCase().includes('cursor')) continue;
      const body = comment.body ?? '';
      const parsed = parseCursorAgentFromComment(body);
      if (parsed !== null) {
        launched = parsed;
        break;
      }
    }
    if (launched !== null) break;
  }

  if (launched === null) {
    throw new Error(
      `Timed out waiting for cursor[bot] on ${issue.html_url} (source:scm launch)`
    );
  }

  // Best-effort close — clutter reduction; launch already succeeded.
  try {
    await githubFetch(
      `/repos/${owner}/${repo}/issues/${issue.number}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          state: 'closed',
          state_reason: 'completed',
        }),
      },
      fetchImpl
    );
  } catch (error) {
    log.warn('Failed to close Report Bug GitHub issue', {
      issue_number: issue.number,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  log.info('Cursor agent launched via GitHub (source:scm)', {
    cursor_agent_id: launched.id,
    name: input.name,
    url: launched.url,
    issue_number: issue.number,
  });

  return {
    id: launched.id,
    name: input.name,
    url: launched.url,
    status: 'ACTIVE',
    github_issue_url: issue.html_url,
    github_issue_number: issue.number,
    launch_source: 'scm',
  };
}
