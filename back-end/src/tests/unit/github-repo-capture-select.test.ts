/**
 * Coverage 2026-10-03: agents boundary took githubCalls[0] from the shared
 * capture buffer and failed when a concurrent auto-RCA /dispatches landed first:
 *   Expected GitHub repos URL, got https://api.github.com/repos/Rose-Ai-Labs/rose/dispatches
 */

import assert from 'node:assert/strict';

import {
  GITHUB_USER_REPOS_URL,
  selectGithubRepoCreationCall,
} from '../helpers/github-repo-capture';

const DISPATCH_URL = 'https://api.github.com/repos/Rose-Ai-Labs/rose/dispatches';

function firstGithubCall<T extends { url: string }>(calls: readonly T[]): T | undefined {
  return calls.find((call) => call.url.includes('api.github.com'));
}

function testFirstGithubUrlPicksDispatchNoise(): void {
  const calls = [{ url: DISPATCH_URL }, { url: GITHUB_USER_REPOS_URL }];
  const call = firstGithubCall(calls);
  assert.equal(call?.url, DISPATCH_URL);
  assert.notEqual(
    call?.url,
    GITHUB_USER_REPOS_URL,
    'first api.github.com URL is the deploy failure: Expected GitHub repos URL, got dispatches'
  );
}

function testSelectorIgnoresConcurrentDispatches(): void {
  const calls = [
    { url: DISPATCH_URL, method: 'POST' },
    { url: GITHUB_USER_REPOS_URL, method: 'POST' },
    { url: 'https://api.github.com/repos/example/repo', method: 'GET' },
  ];
  const call = selectGithubRepoCreationCall(calls);
  assert.equal(call?.url, GITHUB_USER_REPOS_URL);
  assert.equal(call?.method, 'POST');
}

function testSelectorReturnsUndefinedWhenOnlyDispatches(): void {
  assert.equal(selectGithubRepoCreationCall([{ url: DISPATCH_URL }]), undefined);
}

testFirstGithubUrlPicksDispatchNoise();
testSelectorIgnoresConcurrentDispatches();
testSelectorReturnsUndefinedWhenOnlyDispatches();
process.stdout.write('github-repo-capture-select: ok\n');
