/**
 * Merge facts a code-agent tool result reports (plan §4, criterion C4).
 *
 *   checkpoint repo facts (branch, head, local commits)
 *     ├─ GET /repos/:o/:r/pulls?head=:o::branch&state=all   → newest PR for the branch
 *     ├─ GET /repos/:o/:r (only when the merge target is unknown) → default branch
 *     └─ GET /repos/:o/:r/compare/:target...:head           → does the target contain head?
 *
 * `merged` is true ONLY when GitHub says the PR is merged AND the merge target
 * contains the head sha. A squash merge rewrites the sha, so it reports
 * pr.merged=true, merge_target_contains_head=false, merged=false: the facts
 * stay honest and the parent's verifier decides what the goal needed.
 *
 * 10k agents: at most three GitHub calls per close of a repo session; an
 * already-confirmed merge of the same head is reused without calling GitHub.
 */
import { parseGithubUrl } from '../github';
import { createLogger } from '../logger';
import type { RepoFacts } from './lifecycle';

const log = createLogger('CodeSessionMergeFacts');
const GITHUB_TIMEOUT_MS = 10_000;

export interface CodeSessionPullRequest {
  number: number;
  url: string;
  state: string;
  merged: boolean;
}

export interface CodeSessionMergeFacts {
  branch: string | null;
  /** Resolved merge target name (the parent's branch, else the default branch). */
  merge_target: string | null;
  head: string | null;
  local_commits: number;
  pushed: boolean;
  pr: CodeSessionPullRequest | null;
  merge_target_contains_head: boolean | null;
  /** True only when GitHub confirms the PR merged and the merge target contains head. */
  merged: boolean;
  /** How the facts were established. */
  source: 'github' | 'cached' | 'no_repo' | 'github_unavailable';
}

type FetchLike = typeof fetch;

function githubApiBase(): string {
  return (process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
}

async function githubJson(
  fetchImpl: FetchLike,
  path: string
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetchImpl(`${githubApiBase()}${path}`, {
    headers,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function newestPull(body: unknown): CodeSessionPullRequest | null {
  if (!Array.isArray(body)) return null;
  const pulls = body
    .map(record)
    .filter((pull): pull is Record<string, unknown> => pull !== null)
    .sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0));
  const pull = pulls[0];
  if (pull === undefined || typeof pull.number !== 'number') return null;
  return {
    number: pull.number,
    url: typeof pull.html_url === 'string' ? pull.html_url : '',
    state: typeof pull.state === 'string' ? pull.state : 'unknown',
    merged: typeof pull.merged_at === 'string' && pull.merged_at !== '',
  };
}

export interface ResolveMergeFactsParams {
  repoUrl: string | null;
  repo: RepoFacts | null;
  /** Session merge target; null = the repo's default branch. */
  mergeTarget: string | null;
  /** Facts from an earlier close; a confirmed merge of the same head is reused. */
  previous?: CodeSessionMergeFacts | null;
  fetchImpl?: FetchLike;
}

export async function resolveMergeFacts(
  params: ResolveMergeFactsParams
): Promise<CodeSessionMergeFacts> {
  const repo = params.repo;
  const base: CodeSessionMergeFacts = {
    branch: repo?.branch ?? null,
    merge_target: params.mergeTarget ?? repo?.defaultBranch ?? null,
    head: repo?.head ?? null,
    local_commits: repo?.localCommits ?? 0,
    pushed: repo?.pushed ?? false,
    pr: null,
    merge_target_contains_head: null,
    merged: false,
    source: 'no_repo',
  };
  const parsed = params.repoUrl !== null ? parseGithubUrl(params.repoUrl) : null;
  if (parsed === null || base.branch === null || base.head === null) return base;
  const previous = params.previous;
  if (previous?.merged === true && previous.head === base.head && previous.branch === base.branch) {
    return { ...base, ...previous, local_commits: base.local_commits, source: 'cached' };
  }
  const fetchImpl = params.fetchImpl ?? fetch;
  const repoPath = `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  try {
    const pulls = await githubJson(
      fetchImpl,
      `${repoPath}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${parsed.owner}:${base.branch}`)}`
    );
    const pr = pulls.status === 200 ? newestPull(pulls.body) : null;
    let target = base.merge_target;
    if (target === null) {
      const info = await githubJson(fetchImpl, repoPath);
      const defaultBranch = record(info.body)?.default_branch;
      target = typeof defaultBranch === 'string' ? defaultBranch : null;
    }
    let contains: boolean | null = null;
    if (target !== null) {
      const compare = await githubJson(
        fetchImpl,
        `${repoPath}/compare/${encodeURIComponent(target)}...${encodeURIComponent(base.head)}`
      );
      const status = record(compare.body)?.status;
      // target...head is "behind"/"identical" exactly when head is already in target.
      contains =
        compare.status === 200 ? status === 'behind' || status === 'identical' : false;
    }
    return {
      ...base,
      merge_target: target,
      pr,
      merge_target_contains_head: contains,
      merged: pr?.merged === true && contains === true,
      source: 'github',
    };
  } catch (error) {
    log.warn('GitHub merge facts unavailable; reporting merged=false', {
      repo: `${parsed.owner}/${parsed.repo}`,
      branch: base.branch,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...base, source: 'github_unavailable' };
  }
}
