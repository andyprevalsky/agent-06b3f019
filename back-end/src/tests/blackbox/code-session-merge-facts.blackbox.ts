#!/usr/bin/env tsx
/**
 * Black-box contract for code-session merge facts and commit guidance
 * (rose-builds-rose C3, C4; code-agent-persistent-sessions.md §4).
 *
 *   local GitHub API mock ──resolveMergeFacts──► merged only when GitHub confirms
 *                                                the PR merged AND the target has head
 *   buildCodeAgentSystemPrompt / template CLAUDE.md ──► branch facts + the Rose skills
 *                         table of contents (C17); commit/merge rules in the code-session skill
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CODE_AGENT_INSTRUCTIONS_VERSION,
  CODE_AGENT_STOCK_INSTRUCTIONS_VERSION,
  buildCodeAgentSystemPrompt,
} from '../../providers/codeAgentPrompt';
import { resolveMergeFacts } from '../../providers/codeSessions/mergeFacts';
import { installedRoseSkills, roseSkillsTableOfContents } from '../../providers/roseSkills/skills';

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

test('code-agent prompt: branch facts in the prompt, commit and merge rules in the code-session skill', () => {
  const prompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/rose-test/app',
    workDir: '/home/user/workspace',
    branch: 'rose/a--b-123456',
    mergeTarget: 'rose/a',
  });
  assert.match(prompt, /You work on branch `rose\/a--b-123456`\. Its merge target is `rose\/a`\./);
  assert.match(prompt, /Read the code-session skill before you commit, merge or finish\./);
  assert.match(prompt, /^- code-session: Use when you work in a repository/m);
  assert.doesNotMatch(prompt, /push the changes before finishing/);
  const rootPrompt = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/rose-test/app',
  });
  assert.match(rootPrompt, /Your merge target is the repository's default branch\./);

  // The rules the prompt used to carry live in the code-session skill (C17).
  const skill = installedRoseSkills(false).find((entry) => entry.name === 'code-session');
  assert.ok(skill, 'code-session is a stock skill');
  const text = skill.files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8') ?? '';
  assert.match(text, /Commit locally whenever a unit of work is complete/);
  assert.match(text, /Merge into your merge target when other agents or the user need your/);
  assert.match(text, /You decide when to commit, push and merge/);
  assert.match(text, /If a rebase or merge is required, resolve it before finishing/);
  assert.match(text, /Never start over\./, 'usage-limit behaviour');
  assert.doesNotMatch(text, /Rose itself/, 'stock code-session has no Rose-in-Rose rule');
  const flaggedText =
    installedRoseSkills(true)
      .find((entry) => entry.name === 'code-session')
      ?.files.find((file) => file.path === 'SKILL.md')
      ?.content.toString('utf8') ?? '';
  assert.match(flaggedText, /checkout is Rose itself, never merge, push\s+to main or deploy/);

  const template = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'CLAUDE.md'),
    'utf8'
  );
  assert.doesNotMatch(template, /git push origin main/);
  assert.match(template, /Commit, merge and branch rules are in the code-session skill/);
});

test('code-agent prompt: a byte-stable skills table of contents per account group', () => {
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
  const flagged = buildCodeAgentSystemPrompt({ ...args, roseDesktop: true });
  // Byte-stable per skill set (prompt caching): same inputs, same bytes.
  assert.equal(buildCodeAgentSystemPrompt(args), stock);
  assert.equal(buildCodeAgentSystemPrompt({ ...args, roseDesktop: true }), flagged);
  assert.ok(
    stock.startsWith(`Rose Labs code-agent instructions (${CODE_AGENT_STOCK_INSTRUCTIONS_VERSION})`)
  );
  assert.ok(
    flagged.startsWith(`Rose Labs code-agent instructions (${CODE_AGENT_INSTRUCTIONS_VERSION})`)
  );

  const stockToc = roseSkillsTableOfContents(installedRoseSkills(false)).join('\n');
  const flaggedToc = roseSkillsTableOfContents(installedRoseSkills(true)).join('\n');
  assert.ok(stock.includes(`\n${stockToc}\n`), 'stock prompt lists the stock skills');
  assert.ok(flagged.includes(`\n${flaggedToc}\n`), 'flagged prompt lists every skill');
  assert.deepEqual(
    installedRoseSkills(false).map((skill) => skill.name),
    ['agent-graph', 'code-session', 'talk-to-user']
  );
  for (const name of ['apps-preview', 'rose-ui']) {
    assert.ok(flagged.includes(`\n- ${name}: `), `flagged TOC lists ${name}`);
    assert.ok(!stock.includes(`- ${name}: `), `stock TOC omits ${name}`);
  }

  // The per-feature blocks are gone: the table of contents replaces them.
  for (const prompt of [stock, flagged]) {
    for (const removed of [
      'Talking to the user:',
      'Rose app UI:',
      'Live preview and apps',
      'Rose agent graph:',
      'rose_user_ui',
      'screenshots/current',
    ]) {
      assert.ok(!prompt.includes(removed), `prompt still carries "${removed}"`);
    }
  }
  for (const term of ['pinned', 'inline_view', 'inline-view', 'rose-ui', 'rose-preview']) {
    assert.ok(!stock.includes(term), `stock code-agent prompt mentions ${term}`);
  }

  // Only the version line and the extra skills differ between the groups.
  const stockLines = new Set(stock.split('\n'));
  const flaggedOnly = flagged.split('\n').filter((line) => !stockLines.has(line));
  assert.deepEqual(
    flaggedOnly.slice(1),
    flaggedToc.split('\n').filter((line) => !stockLines.has(line)),
    `unexpected Rose Desktop-only lines: ${JSON.stringify(flaggedOnly)}`
  );
  // Size: the table of contents is a few lines, and the prompt stays compact.
  assert.ok(flaggedToc.split('\n').length <= 12, 'table of contents is a few lines');
  assert.ok(stock.length < 3_500, `stock prompt is ${stock.length} chars`);
  assert.ok(flagged.length < 4_000, `flagged prompt is ${flagged.length} chars`);

  // The template CLAUDE.md ships in every account's image, so it lists the stock skills.
  const template = readFileSync(
    join(process.cwd(), '..', 'e2b-templates', 'claude-code', 'CLAUDE.md'),
    'utf8'
  );
  assert.ok(template.includes(`\n${stockToc}\n`), 'template CLAUDE.md lists the stock skills');
  for (const term of ['pinned', 'inline_view', 'rose-ui']) {
    assert.ok(!template.includes(term), `template CLAUDE.md mentions ${term}`);
  }
});
