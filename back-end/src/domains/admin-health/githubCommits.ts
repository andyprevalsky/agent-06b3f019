import { mapWithConcurrency } from '../../providers/concurrency';
import {
  ensureGithubAppToken,
  githubTokenCandidates,
  recordGithubResponse,
} from '../../providers/githubTokenPool';
import { createLogger } from '../../providers/logger';
import { GITHUB_REPO } from './config';

const log = createLogger('AdminHealth');

export interface DatedValue {
  date: Date;
  value: number;
}

interface GithubCommitPage {
  items: DatedValue[];
  full: boolean;
  lastPage: number | null;
}

const GITHUB_MAX_COMMIT_PAGES = 500;
const GITHUB_COMMITS_PER_PAGE = 100;
// ~100 pages of commits took ~35s one at a time; GitHub allows 100 concurrent requests.
const GITHUB_PAGE_CONCURRENCY = 20;
const GITHUB_FETCH_BUDGET_MS = 60_000;
/**
 * GitHub API tokens for admin-health velocity (commits graph), best first.
 *
 * Read at call time (not module load) from the shared token pool: members with
 * the most remaining quota first, and a present-but-stale `GITHUB_TOKEN` can
 * still fall back to `GITHUB_DISPATCH_TOKEN` (Render has repeatedly shipped a
 * dead fine-grained PAT while the dispatch oauth token still has `repo` scope).
 * It lives here, not in config.ts: the config layer may not import providers.
 */
export function githubApiTokenCandidates(): string[] {
  return githubTokenCandidates('pool');
}

// 404 counts: GitHub answers 404 when a credential cannot see the private repo.
const GITHUB_AUTH_FAILURE = /^GitHub (401|403|404|429)$/;

function lastPageFromLink(link: string | null): number | null {
  for (const part of (link ?? '').split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="last"/.exec(part);
    if (match === null) continue;
    const page = Number(new URL(match[1]).searchParams.get('page'));
    return Number.isInteger(page) && page > 0 ? page : null;
  }
  return null;
}

async function fetchGithubCommitPage(
  token: string,
  owner: string,
  repoName: string,
  start: Date,
  end: Date,
  page: number,
  signal: AbortSignal
): Promise<GithubCommitPage> {
  const url = new URL(`https://api.github.com/repos/${owner}/${repoName}/commits`);
  url.searchParams.set('since', start.toISOString());
  url.searchParams.set('until', end.toISOString());
  url.searchParams.set('per_page', String(GITHUB_COMMITS_PER_PAGE));
  url.searchParams.set('page', String(page));
  const response = await fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  recordGithubResponse(token, response.status, response.headers);
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  const commits = (await response.json()) as Array<{
    commit: { committer?: { date?: string | null }; author?: { date?: string | null } };
  }>;
  const items: DatedValue[] = [];
  for (const commit of commits) {
    const date = commit.commit.committer?.date ?? commit.commit.author?.date;
    if (date !== undefined && date !== null && date !== '') {
      items.push({ date: new Date(date), value: 1 });
    }
  }
  return {
    items,
    full: commits.length >= GITHUB_COMMITS_PER_PAGE,
    lastPage: lastPageFromLink(response.headers.get('link')),
  };
}

async function fetchGithubItemsWithToken(
  token: string,
  owner: string,
  repoName: string,
  start: Date,
  end: Date,
  signal: AbortSignal
): Promise<DatedValue[]> {
  // One failed page fails the metric, so cancel the pages still in flight.
  const failed = new AbortController();
  const pageSignal = AbortSignal.any([signal, failed.signal]);
  const fetchPage = async (page: number): Promise<GithubCommitPage> => {
    try {
      return await fetchGithubCommitPage(token, owner, repoName, start, end, page, pageSignal);
    } catch (error) {
      failed.abort(error);
      throw error;
    }
  };
  let latest = await fetchPage(1);
  const items = [...latest.items];
  let page = 1;
  // Page 1's Link header names the final page, so the rest are independent
  // requests: fetch them concurrently instead of one round trip per page.
  const lastPage = Math.min(latest.lastPage ?? 1, GITHUB_MAX_COMMIT_PAGES);
  if (latest.full && lastPage > 1) {
    const pageNumbers = Array.from({ length: lastPage - 1 }, (_, index) => index + 2);
    const pages = await mapWithConcurrency(pageNumbers, GITHUB_PAGE_CONCURRENCY, fetchPage);
    for (const result of pages) items.push(...result.items);
    latest = pages[pages.length - 1] ?? latest;
    page = lastPage;
  }
  // Walk on serially if the final page was still full (commits landed mid-walk,
  // or the Link header was missing).
  while (latest.full && page < GITHUB_MAX_COMMIT_PAGES) {
    page += 1;
    latest = await fetchPage(page);
    items.push(...latest.items);
  }
  if (latest.full) {
    log.warn('GitHub commit pagination reached its safety limit', {
      owner,
      repo: repoName,
      maxPages: GITHUB_MAX_COMMIT_PAGES,
    });
  }
  return items;
}

export async function fetchGithubItems(start: Date, end: Date): Promise<DatedValue[]> {
  const [owner, repoName] = GITHUB_REPO.split('/');
  if (!owner || !repoName) throw new Error(`Invalid ADMIN_HEALTH_GITHUB_REPO: ${GITHUB_REPO}`);
  await ensureGithubAppToken();
  const candidates = githubApiTokenCandidates();
  if (candidates.length === 0) {
    throw new Error('GITHUB_TOKEN / GITHUB_DISPATCH_TOKEN is not configured.');
  }
  let lastAuthError: Error | null = null;
  const signal = AbortSignal.timeout(GITHUB_FETCH_BUDGET_MS);
  for (let index = 0; index < candidates.length; index += 1) {
    const token = candidates[index];
    try {
      return await fetchGithubItemsWithToken(token, owner, repoName, start, end, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!GITHUB_AUTH_FAILURE.test(message)) throw error;
      lastAuthError = error instanceof Error ? error : new Error(message);
      const hasFallback = index < candidates.length - 1;
      log.warn('GitHub token rejected for commits fetch', {
        status: message,
        attemptingFallback: hasFallback,
      });
      if (!hasFallback) break;
    }
  }
  throw lastAuthError ?? new Error('GitHub auth failed');
}
