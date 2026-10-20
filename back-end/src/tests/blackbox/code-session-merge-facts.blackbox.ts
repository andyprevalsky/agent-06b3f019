#!/usr/bin/env tsx
/**
 * Black-box contract for code-session merge facts and commit guidance
 * (rose-builds-rose C3, C4; code-agent-persistent-sessions.md §4).
 *
 *   local GitHub API mock ──resolveMergeFacts──► merged only when GitHub confirms
 *                                                the PR merged AND the target has head
 *   buildCodeAgentSystemPrompt / template CLAUDE.md ──► commit locally, merge when needed
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildCodeAgentSystemPrompt } from '../../providers/codeAgentPrompt';
import { resolveMergeFacts } from '../../providers/codeSessions/mergeFacts';

const savedGithubApi = process.env.GITHUB_API_BASE_URL;

after(() => {
  if (savedGithubApi === undefined) delete process.env.GITHUB_API_BASE_URL;
  else process.env.GITHUB_API_BASE_URL = savedGithubApi;
});

test('merged is reported only when GitHub confirms the merge and the target contains head', async () => {
  const head = 'c'.repeat(40);
  let scenario: { pulls: unknown[]; compare: number | string } = { pulls: [], compare: 404 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.test');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/repos/rose-test/app/pulls') {
      assert.equal(url.searchParams.get('head'), 'rose-test:rose/feature-1');
      res.end(JSON.stringify(scenario.pulls));
    } else if (url.pathname === `/repos/rose-test/app/compare/main...${head}`) {
      if (typeof scenario.compare === 'number') {
        res.statusCode = scenario.compare;
        res.end('{}');
      } else res.end(JSON.stringify({ status: scenario.compare }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const repo = {
    path: 'workspace',
    branch: 'rose/feature-1',
    head,
    localCommits: 0,
    pushed: true,
    remoteUrl: 'https://github.com/rose-test/app',
    dirtyFiles: 0,
    defaultBranch: 'main',
  };
  const facts = () =>
    resolveMergeFacts({ repoUrl: 'https://github.com/rose-test/app', repo, mergeTarget: 'main' });
  const pr = (merged: boolean) => [
    {
      number: 12,
      html_url: 'https://github.com/rose-test/app/pull/12',
      state: merged ? 'closed' : 'open',
      merged_at: merged ? '2026-10-20T00:00:00Z' : null,
    },
  ];
  try {
    scenario = { pulls: [], compare: 404 };
    assert.equal((await facts()).merged, false, 'unpushed head: not merged');
    scenario = { pulls: pr(false), compare: 'ahead' };
    const open = await facts();
    assert.equal(open.merged, false);
    assert.equal(open.pr?.number, 12);
    scenario = { pulls: pr(true), compare: 'diverged' };
    const squashed = await facts();
    assert.equal(squashed.pr?.merged, true);
    assert.equal(squashed.merge_target_contains_head, false);
    assert.equal(
      squashed.merged,
      false,
      'a merged PR whose head is not in main is not reported merged'
    );
    scenario = { pulls: pr(true), compare: 'behind' };
    const merged = await facts();
    assert.equal(merged.merged, true);
    assert.equal(merged.merge_target, 'main');
    assert.equal(merged.source, 'github');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('code-agent prompt: commit locally per unit of work, merge into the merge target when needed', () => {
  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/rose-test/app',
    workDir: '/home/user/workspace',
    branch: 'rose/a--b-123456',
    mergeTarget: 'rose/a',
  });
  assert.match(prompt, /You work on branch `rose\/a--b-123456`\. Its merge target is `rose\/a`\./);
  assert.match(prompt, /Commit locally whenever a unit of work is complete/);
  assert.match(prompt, /Merge into `rose\/a` when other agents or the user need your changes/);
  assert.match(prompt, /You decide when to commit, push and merge/);
  assert.doesNotMatch(prompt, /push the changes before finishing/);
  const rootPrompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/rose-test/app',
  });
  assert.match(rootPrompt, /Merge into the repository's default branch when other agents/);
  const template = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'CLAUDE.md'),
    'utf8'
  );
  assert.doesNotMatch(template, /git push origin main/);
  assert.match(template, /Commit locally whenever a unit of work is complete/);
});

test('code-agent prompt: Rose app UI, pinned questions and inline views only for Rose Desktop accounts', () => {
  // Rose Desktop gate (providers/roseDesktop): every other account keeps the
  // stock prompt, byte-stable, with none of the new-UI instructions.
  const args = {
    githubRepoUrl: 'https://github.com/rose-test/app',
    workDir: '/home/user/workspace',
  };
  const stock = buildCodeAgentSystemPrompt(args);
  assert.equal(
    stock,
    buildCodeAgentSystemPrompt({ ...args, roseDesktop: false }),
    'default is stock'
  );
  for (const term of [
    'Rose app UI',
    'rose_user_ui',
    'rose-ui',
    'pinned',
    'inline_view',
    'questions',
  ]) {
    assert.ok(!stock.includes(term), `stock code-agent prompt mentions ${term}`);
  }
  assert.match(
    stock,
    /`send_message_to_user` for updates and results; `display` for screenshots, recordings and HTML previews; `request_user_approval` before risky or irreversible actions\. Approvals wait for the answer\./
  );

  const flagged = buildCodeAgentSystemPrompt({ ...args, roseDesktop: true });
  assert.match(flagged, /~\/rose_user_ui is the Rose app UI of the user you work for/);
  assert.match(flagged, /`rose-ui check` must pass before `rose-ui publish`/);
  assert.match(flagged, /`display` with placement "pinned" and options for a question/);
  assert.match(flagged, /`send_message_to_user` with `inline_view`/);
  // Every other line is shared: only the new-UI section and lines differ.
  const stockLines = new Set(stock.split('\n'));
  const flaggedOnly = flagged.split('\n').filter((line) => !stockLines.has(line));
  assert.ok(
    flaggedOnly.every((line) =>
      /rose_user_ui|rose-ui|Rose app UI|inline view|inline_view|pinned|questions/.test(line)
    ),
    `unexpected Rose Desktop-only lines: ${JSON.stringify(flaggedOnly)}`
  );

  // The template CLAUDE.md ships in every account's image, so it stays generic.
  const template = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'CLAUDE.md'),
    'utf8'
  );
  for (const term of ['pinned', 'inline_view', 'rose-ui']) {
    assert.ok(!template.includes(term), `template CLAUDE.md mentions ${term}`);
  }
});
