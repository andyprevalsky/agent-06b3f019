#!/usr/bin/env tsx
/**
 * Canonical connected-repo refs (providers/githubRepos/refs.ts): every legacy
 * GitHub spelling (project repoUrl, agent githubRepoUrl, `owner/repo`) maps to
 * one stable `gh:<owner>/<repo>` ref; non-GitHub remotes never do.
 */
import assert from 'node:assert/strict';
import {
  canonicalGithubRepoRef,
  githubRepoIdentity,
  isCanonicalGithubRepoRef,
  sameGithubRepo,
} from '../../providers/githubRepos/refs';

const ROSE = 'gh:rose-ai-labs/rose';

for (const spelling of [
  'https://github.com/Rose-Ai-Labs/rose',
  'https://github.com/Rose-Ai-Labs/rose.git',
  'http://github.com/Rose-Ai-Labs/rose/tree/main',
  'github.com/Rose-Ai-Labs/rose',
  'Rose-Ai-Labs/rose',
  'gh:Rose-Ai-Labs/rose',
  ROSE,
  '  https://github.com/rose-ai-labs/ROSE  ',
]) {
  assert.equal(canonicalGithubRepoRef(spelling), ROSE, spelling);
}

assert.deepEqual(githubRepoIdentity('https://github.com/Rose-Ai-Labs/rose.git'), {
  canonicalRef: ROSE,
  repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
  owner: 'Rose-Ai-Labs',
  repoName: 'rose',
});

for (const notGithub of [
  null,
  undefined,
  '',
  'git@github.com:Rose-Ai-Labs/rose.git',
  'https://gitlab.com/a/b',
  '/home/user/rose',
  'rose-project:aaaaaaaa-0000-4000-8000-000000000001',
]) {
  assert.equal(canonicalGithubRepoRef(notGithub), null, String(notGithub));
}

assert.equal(isCanonicalGithubRepoRef(ROSE), true);
assert.equal(isCanonicalGithubRepoRef('https://github.com/Rose-Ai-Labs/rose'), false);
assert.equal(sameGithubRepo('https://github.com/Rose-Ai-Labs/rose.git', ROSE), true);
assert.equal(sameGithubRepo('https://github.com/Rose-Ai-Labs/rose', 'Rose-Ai-Labs/other'), false);
assert.equal(sameGithubRepo(null, null), false);

process.stdout.write('github-repo-refs: ok\n');
