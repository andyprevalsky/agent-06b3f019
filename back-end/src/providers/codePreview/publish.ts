/**
 * Publish a code session's work (Rose-in-Rose, A1): push its branch from the
 * session's own checkout and open a pull request. It never merges, never
 * pushes the merge target and never deploys; Rose ships only via `/deploy`.
 *
 *   POST /:taskId/publish
 *     └─ publishCodeSessionBranch(session, fs)
 *          git (in ~/workspace)  current branch ≠ merge target, HEAD sha
 *          git push origin HEAD:refs/heads/<branch>     (no force)
 *          GitHub (C4 helper)    POST /repos/:o/:r/pulls {head, base}
 *                                422 "already exists" → the open PR for head
 *
 * Idempotent: a second publish pushes the same ref (a no-op when unchanged)
 * and returns the existing PR with created=false.
 *
 * 10k-agent behaviour: user-initiated only; one git push in that session's
 * sandbox and at most two GitHub calls per publish. No polling.
 */
import { createLogger } from '../logger';
import { githubRepoOf } from './preview';
import { type CodeSessionFs, shellQuote } from '../codeSessions/sandboxFs';
import { githubJson, newestPull, record } from '../codeSessions/mergeFacts';
import type { RepoFacts } from '../codeSessions/lifecycle';

const log = createLogger('CodeSessionPublish');
const PUSH_TIMEOUT_MS = 5 * 60_000;
const GIT_TIMEOUT_MS = 60_000;

export class CodePublishError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CodePublishError';
  }
}

export interface CodePublishSession {
  id: string;
  repoUrl: string | null;
  branch: string | null;
  mergeTarget: string | null;
  lastRepoFacts: unknown;
}

export interface CodePublishResult {
  code_session_id: string;
  repo: string;
  branch: string;
  base: string;
  head_sha: string;
  pushed: true;
  pr: { number: number; url: string; state: string; draft: boolean };
  /** False when the branch already had an open PR (that PR is returned). */
  created: boolean;
  /** Publishing never merges: shipping happens only through /deploy. */
  merged: false;
}

function redact(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@').slice(-1500);
}

function repoDirOf(session: CodePublishSession, home: string): string {
  const facts = session.lastRepoFacts as Partial<RepoFacts> | null;
  const rel = typeof facts?.path === 'string' && facts.path !== '' ? facts.path : 'workspace';
  return rel.startsWith('/') ? rel : `${home}/${rel}`;
}

async function git(fs: CodeSessionFs, repoDir: string, args: string, timeoutMs = GIT_TIMEOUT_MS) {
  return fs.exec(`cd ${shellQuote(repoDir)} && git ${args}`, { timeoutMs });
}

export async function publishCodeSessionBranch(params: {
  session: CodePublishSession;
  fs: CodeSessionFs;
  title?: string;
  body?: string;
  draft?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<CodePublishResult> {
  const { session, fs } = params;
  const parsed = githubRepoOf(session.repoUrl);
  if (parsed === null) {
    throw new CodePublishError(409, 'NOT_A_GITHUB_REPO', 'This code session has no GitHub repo');
  }
  const { owner, repo } = parsed;
  const fetchImpl = params.fetchImpl ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repoDir = repoDirOf(session, fs.home);

  const current = await git(fs, repoDir, 'symbolic-ref --short -q HEAD');
  const branch = current.exitCode === 0 ? current.stdout.trim() : '';
  if (branch === '') {
    throw new CodePublishError(409, 'NO_BRANCH', 'The session checkout is not on a branch');
  }
  let base = session.mergeTarget;
  if (base === null || base === '') {
    const info = await githubJson(fetchImpl, repoPath);
    const defaultBranch = record(info.body)?.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch === '') {
      throw new CodePublishError(502, 'GITHUB_UNAVAILABLE', 'Could not read the default branch');
    }
    base = defaultBranch;
  }
  if (branch === base) {
    throw new CodePublishError(
      409,
      'ON_MERGE_TARGET',
      `The session is on ${base}; publish opens a PR from a work branch and never pushes ${base}`
    );
  }
  const head = await git(fs, repoDir, 'rev-parse HEAD');
  if (head.exitCode !== 0)
    throw new CodePublishError(409, 'NO_COMMITS', 'The branch has no commits');
  const headSha = head.stdout.trim();

  const push = await git(
    fs,
    repoDir,
    `push --porcelain origin ${shellQuote(`HEAD:refs/heads/${branch}`)}`,
    PUSH_TIMEOUT_MS
  );
  if (push.exitCode !== 0) {
    log.warn('Publish push failed', { codeSessionId: session.id, branch });
    throw new CodePublishError(
      502,
      'PUSH_FAILED',
      `git push failed: ${redact(push.stderr || push.stdout)}`
    );
  }

  const subject = await git(fs, repoDir, 'log -1 --format=%s');
  const title =
    params.title?.trim() || (subject.exitCode === 0 ? subject.stdout.trim() : '') || branch;
  const body =
    params.body?.trim() ||
    `Opened from Rose (code session ${session.id}).\n\nShips only through \`/deploy\`; Rose never merges this PR itself.`;
  const created = await githubJson(fetchImpl, `${repoPath}/pulls`, {
    method: 'POST',
    body: { title, head: branch, base, body, draft: params.draft === true },
  });
  let pr = record(created.body);
  let isNew = created.status === 201;
  if (!isNew) {
    // 422: a PR for this head already exists; return it instead of failing.
    const open = await githubJson(
      fetchImpl,
      `${repoPath}/pulls?state=open&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`
    );
    const existing = open.status === 200 ? newestPull(open.body) : null;
    if (existing === null) {
      const message = typeof pr?.message === 'string' ? pr.message : `HTTP ${created.status}`;
      throw new CodePublishError(502, 'PR_CREATE_FAILED', `GitHub refused the PR: ${message}`);
    }
    pr = { number: existing.number, html_url: existing.url, state: existing.state, draft: false };
    isNew = false;
  }
  if (pr === null || typeof pr.number !== 'number') {
    throw new CodePublishError(502, 'PR_CREATE_FAILED', 'GitHub returned no pull request');
  }
  log.info('Published code session branch', {
    codeSessionId: session.id,
    repo: `${owner}/${repo}`,
    branch,
    base,
    pr: String(pr.number),
    created: String(isNew),
  });
  return {
    code_session_id: session.id,
    repo: `${owner}/${repo}`,
    branch,
    base,
    head_sha: headSha,
    pushed: true,
    pr: {
      number: pr.number,
      url: typeof pr.html_url === 'string' ? pr.html_url : '',
      state: typeof pr.state === 'string' ? pr.state : 'open',
      draft: pr.draft === true,
    },
    created: isNew,
    merged: false,
  };
}
