#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { workDirForGithubRepo } from '../../providers/e2bWorkDir';

const USER_HOME = '/home/user';
const REPO_WORKDIR = '/home/user/workspace';

assert.strictEqual(workDirForGithubRepo('https://github.com/rose-ai-labs/rose'), REPO_WORKDIR);
assert.strictEqual(workDirForGithubRepo('https://github.com/rose-ai-labs/rose.git/'), REPO_WORKDIR);

for (const unsupported of [
  undefined,
  '',
  'not-a-url',
  'http://github.com/rose-ai-labs/rose',
  'https://gitlab.com/rose-ai-labs/rose',
  'https://github.com/rose-ai-labs',
  'https://github.com/rose-ai-labs/rose/extra',
  'https://user:password@github.com/rose-ai-labs/rose',
  'file:///home/user/workspace',
]) {
  assert.strictEqual(workDirForGithubRepo(unsupported), USER_HOME, String(unsupported));
}

console.log('e2b workdir URL validation tests passed.');
