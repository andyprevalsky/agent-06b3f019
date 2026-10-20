#!/usr/bin/env tsx
/**
 * Black-box contract for Rose-in-Rose code-session previews and publish
 * (rose-builds-rose A1; L-APPS).
 *
 *   GET  /api/claude-code-session/:taskId/preview   dev accounts only (403), owner-scoped (404)
 *   POST /api/claude-code-session/:taskId/publish   push the branch + open a PR, never merge
 *   POST /api/claude-code-session/:taskId/preview/handoff + POST /api/preview-handoff/redeem
 *        one-time preview sign-in (code-preview-handoff.cases.ts)
 *
 *   real Rose front-end copy in a session HOME ──rose-preview start──► real vite (HMR)
 *     └─ backend reports its preview_url ──► headless Chromium ──agent write──► DOM ≤ 3 s
 *   fake GitHub API + local bare origin ──publishCodeSessionBranch──► PR opened, idempotent
 *
 * Nothing reaches E2B or GitHub: the E2B case uses an `.invalid` sandbox domain,
 * publish runs against a local mock, and the HMR case runs on this host.
 *
 * Usage: bash scripts/run-blackbox-tests.sh code-preview
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { config } from 'dotenv';
import { chromium, type Browser } from 'playwright';
import { prisma } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { localCodeSessionHome } from '../../providers/codeSessions/lifecycle';
import { localSandboxFs } from '../../providers/codeSessions/sandboxFs';
import { buildCodeAgentSystemPrompt } from '../../providers/codeAgentPrompt';
import { installedRoseSkills } from '../../providers/roseSkills/skills';
import {
  CODE_PREVIEW_CLI_PATH,
  codePreviewToolFiles,
  e2bPreviewUrl,
  isRoseRepoUrl,
} from '../../providers/codePreview/preview';
import {
  applyPreviewUrlEnv,
  autostartRosePreview,
  stopLocalCodePreview,
} from '../../providers/codePreview/sandbox';
import { CodePublishError, publishOwnedTask } from '../../providers/codePreview/service';
import { prepareCodeSessionWorkspace } from '../../providers/codeSessionWorkspace';
import { ROSE_DEV_USER_IDS, isRoseDevUser } from '../../utils/roseDevAccess';
import { previewHandoffCases } from './code-preview-handoff.cases';
import {
  HMR_EDIT_FILE,
  HMR_EDIT_ROUTE,
  HMR_EDIT_TEXT,
  makeRoseFrontEndHome,
  percentile,
} from './code-preview.support';

config();

const execFileAsync = promisify(execFile);
const baseUrl = process.env.TEST_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.BACKEND_API_KEY || '';
const DEV_USER = ROSE_DEV_USER_IDS[0];
const OTHER_USER = `code-preview-other-${randomUUID()}`;
const HMR_BUDGET_MS = 3_000;
const HMR_EDITS = 5;
const fixtureDir = mkdtempSync(join(tmpdir(), 'code-preview-blackbox-'));
const createdAgents: string[] = [];
const createdSessions: string[] = [];
const createdTasks: string[] = [];
const localHomes: string[] = [];

async function http(method: string, path: string, userId: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey, 'X-User-Id': userId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data };
}

async function agentFor(userId: string): Promise<string> {
  const agent = await prisma.agent.create({ data: { userId, goal: 'code-preview blackbox' } });
  createdAgents.push(agent.id);
  return agent.id;
}

async function codeSessionRow(
  userId: string,
  agentId: string,
  data: Partial<{
    repoUrl: string | null;
    state: string;
    sandboxKind: string;
    sandboxId: string;
    homeDir: string | null;
    branch: string | null;
    mergeTarget: string | null;
  }>
) {
  const row = await prisma.codeSession.create({
    data: {
      userId,
      rootAgentId: agentId,
      ownerAgentId: agentId,
      repoUrl: data.repoUrl ?? null,
      repoKey: data.repoUrl ?? '',
      state: data.state ?? 'ACTIVE',
      sandboxKind: data.sandboxKind ?? 'e2b',
      sandboxId: data.sandboxId ?? null,
      homeDir: data.homeDir ?? null,
      branch: data.branch ?? null,
      mergeTarget: data.mergeTarget ?? null,
    },
  });
  createdSessions.push(row.id);
  return row;
}

async function taskRow(
  agentId: string,
  data: { sandboxId: string; streamUrl: string; codeSessionId: string | null }
) {
  const id = randomUUID();
  await prisma.claudeCodeSession.create({
    data: {
      id,
      agentId,
      sandboxId: data.sandboxId === 'local' ? `local-${id}` : data.sandboxId,
      streamUrl: data.streamUrl,
      goal: 'code-preview blackbox',
      status: 'ACTIVE',
      codeSessionId: data.codeSessionId,
      codeProvider: 'claude',
    },
  });
  createdTasks.push(id);
  return id;
}

before(async () => {
  await prisma.user.upsert({
    where: { userId: DEV_USER },
    create: { userId: DEV_USER, name: 'Rose dev (code-preview blackbox)' },
    update: {},
  });
  await prisma.user.create({ data: { userId: OTHER_USER, name: 'Code preview other' } });
});

after(async () => {
  await prisma.previewHandoffCode.deleteMany({ where: { taskId: { in: createdTasks } } });
  await prisma.claudeCodeSession.deleteMany({ where: { id: { in: createdTasks } } });
  await prisma.codeSession.deleteMany({ where: { id: { in: createdSessions } } });
  await prisma.agent.deleteMany({ where: { id: { in: createdAgents } } });
  await prisma.user.deleteMany({ where: { userId: OTHER_USER } });
  await prisma.$disconnect();
  for (const home of localHomes) rmSync(home, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

test('dev allowlist: only the Rose Desktop accounts are dev accounts', () => {
  assert.equal(isRoseDevUser(DEV_USER), true);
  assert.equal(isRoseDevUser(OTHER_USER), false);
  assert.equal(isRoseDevUser(''), false);
  assert.equal(isRoseDevUser(undefined), false);
  assert.equal(isRoseRepoUrl('https://github.com/Rose-Ai-Labs/rose'), true);
  assert.equal(isRoseRepoUrl('https://github.com/rose-ai-labs/rose.git'), true);
  assert.equal(isRoseRepoUrl('git@github.com:Rose-Ai-Labs/rose.git'), true);
  assert.equal(isRoseRepoUrl('https://github.com/Rose-Ai-Labs/rose-other'), false);
  assert.equal(isRoseRepoUrl(null), false);
});

test('non-dev accounts get 403 on preview and publish, even for their own task', async () => {
  const agentId = await agentFor(OTHER_USER);
  const session = await codeSessionRow(OTHER_USER, agentId, { sandboxId: 'sbxother' });
  const taskId = await taskRow(agentId, {
    sandboxId: 'sbxother',
    streamUrl: 'wss://3000-sbxother.e2b.invalid',
    codeSessionId: session.id,
  });
  const preview = await http('GET', `/api/claude-code-session/${taskId}/preview`, OTHER_USER);
  assert.equal(preview.status, 403, JSON.stringify(preview.data));
  assert.equal(preview.data.code, 'ROSE_DEV_ONLY');
  const publish = await http('POST', `/api/claude-code-session/${taskId}/publish`, OTHER_USER, {});
  assert.equal(publish.status, 403, JSON.stringify(publish.data));
  assert.equal(publish.data.code, 'ROSE_DEV_ONLY');
});

test('a dev account gets 404 for a foreign or unknown task', async () => {
  const agentId = await agentFor(OTHER_USER);
  const taskId = await taskRow(agentId, {
    sandboxId: 'sbxforeign',
    streamUrl: 'wss://3000-sbxforeign.e2b.invalid',
    codeSessionId: null,
  });
  const foreign = await http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.data));
  const unknown = await http('GET', `/api/claude-code-session/${randomUUID()}/preview`, DEV_USER);
  assert.equal(unknown.status, 404);
  const publish = await http('POST', `/api/claude-code-session/${taskId}/publish`, DEV_USER, {});
  assert.equal(publish.status, 404);
});

test('cloud preview: the sandbox public host for port 5173; paused sessions are not probed', async () => {
  assert.equal(
    e2bPreviewUrl('wss://3000-abc123.e2b.app', 'abc123'),
    'https://5173-abc123.e2b.app/'
  );
  const agentId = await agentFor(DEV_USER);
  const sandboxId = `sbx${randomUUID().slice(0, 8)}`;
  const session = await codeSessionRow(DEV_USER, agentId, {
    sandboxId,
    repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
  });
  const taskId = await taskRow(agentId, {
    sandboxId,
    streamUrl: `wss://3000-${sandboxId}.e2b.invalid`,
    codeSessionId: session.id,
  });
  const live = await http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER);
  assert.equal(live.status, 200, JSON.stringify(live.data));
  assert.equal(live.data.preview_url, `https://5173-${sandboxId}.e2b.invalid/`);
  assert.equal(live.data.port, 5173);
  assert.equal(live.data.target, 'cloud');
  assert.equal(live.data.code_session_id, session.id);
  assert.equal(live.data.status, 'not_running', 'nothing answers on an .invalid host');
  await prisma.codeSession.update({ where: { id: session.id }, data: { state: 'PAUSED' } });
  const paused = await http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER);
  assert.equal(paused.data.status, 'paused');
  assert.equal(paused.data.preview_url, `https://5173-${sandboxId}.e2b.invalid/`);
});

test('dev sessions get the rose-preview CLI and env; other accounts get neither', async () => {
  const agentId = await agentFor(DEV_USER);
  const dev = await prepareCodeSessionWorkspace(DEV_USER, agentId, randomUUID(), 'claude');
  assert.ok(dev, 'dev workspace prepared');
  assert.ok(
    dev.files.some((file) => file.path === CODE_PREVIEW_CLI_PATH),
    'rose-preview installed'
  );
  assert.equal(dev.envs.ROSE_PREVIEW_PORT, '5173');
  assert.match(dev.envs.ROSE_PREVIEW_BACKEND_URL ?? '', /^https?:\/\//);
  assert.equal(dev.localEnvs?.ROSE_PREVIEW_PORT, '', 'same-host sessions pick a free port');
  const otherAgent = await agentFor(OTHER_USER);
  const other = await prepareCodeSessionWorkspace(OTHER_USER, otherAgent, randomUUID(), 'claude');
  assert.ok(!(other?.files ?? []).some((file) => file.path === CODE_PREVIEW_CLI_PATH));
  assert.equal(other?.envs.ROSE_PREVIEW_PORT, undefined);
});

test('code-agent prompt: Rose-in-Rose shipping rule + apps-preview skill only for dev Rose sessions', () => {
  const rose = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/Rose-Ai-Labs/rose',
    roseDesktop: true,
  });
  assert.match(rose, /^- apps-preview: Use /m, 'the table of contents lists apps-preview');
  assert.match(rose, /^- The checkout in ~\/workspace is Rose itself\./m);
  assert.match(rose, /pull request \(`gh pr create`\)/i);
  assert.match(rose, /never merge/i);
  assert.match(rose, /\/deploy/);
  const plain = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/Rose-Ai-Labs/rose',
  });
  assert.doesNotMatch(plain, /rose-preview|apps-preview|Rose itself/, 'non-dev accounts');
  const devOtherRepo = buildCodeAgentSystemPrompt({
    githubRepoUrl: 'https://github.com/someone/app',
    roseDesktop: true,
  });
  assert.match(devOtherRepo, /^- apps-preview: Use /m);
  assert.doesNotMatch(devOtherRepo, /^Rose itself:$/m);
  const project = buildCodeAgentSystemPrompt({ roseDesktop: true, roseRepo: true });
  assert.match(project, /^Rose itself:$/m, 'a Rose project session (no github url) gets the rule');

  // How to preview and publish is the apps-preview skill (C17), installed for dev accounts only.
  const skill = installedRoseSkills(true).find((entry) => entry.name === 'apps-preview');
  const text = skill?.files.find((file) => file.path === 'SKILL.md')?.content.toString('utf8');
  assert.ok(text, 'apps-preview skill installed for dev accounts');
  assert.match(text, /rose-preview start \[--dir <app dir>\]/);
  assert.match(text, /apps\/<slug>\//);
  assert.match(text, /opening a pull\s+request \(`gh pr create`\)/);
  assert.match(text, /Never merge it, never\s+push to main and never deploy/);
  assert.ok(!installedRoseSkills(false).some((entry) => entry.name === 'apps-preview'));
});

previewHandoffCases({
  baseUrl,
  apiKey,
  devUser: DEV_USER,
  otherUser: OTHER_USER,
  agentFor,
  codeSessionRow,
  taskRow,
});

/** Wait until the page shows `marker`; returns the page wall-clock time it appeared. */
async function armMarkerWatch(page: import('playwright').Page, marker: string): Promise<void> {
  // String evaluates: tsx's keepNames transform would inject __name into closures.
  await page.evaluate(
    `(() => { const m = ${JSON.stringify(marker)}; window.__roseSeenAt = 0;` +
      ' const obs = new MutationObserver(() => { if (document.body.innerText.includes(m)) {' +
      ' window.__roseSeenAt = performance.timeOrigin + performance.now(); obs.disconnect(); } });' +
      ' obs.observe(document.body, { subtree: true, childList: true, characterData: true }); })()'
  );
}

test('Rose-in-Rose HMR: an agent write to the Rose front-end reaches the preview DOM in ≤ 3 s', async () => {
  const agentId = await agentFor(DEV_USER);
  const session = await codeSessionRow(DEV_USER, agentId, {
    sandboxKind: 'local',
    repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
  });
  const home = localCodeSessionHome(session.id);
  localHomes.push(join(home, '..'));
  mkdirSync(home, { recursive: true });
  await prisma.codeSession.update({ where: { id: session.id }, data: { homeDir: home } });
  const taskId = await taskRow(agentId, {
    sandboxId: 'local',
    streamUrl: 'ws://127.0.0.1:9',
    codeSessionId: session.id,
  });
  const frontEnd = makeRoseFrontEndHome(home);
  // The CLI exactly as a dev session installs it.
  const [cli] = codePreviewToolFiles();
  const cliPath = join(home, cli.path);
  mkdirSync(join(cliPath, '..'), { recursive: true });
  writeFileSync(cliPath, cli.content, { mode: 0o755 });
  assert.ok((statSync(cliPath).mode & 0o111) !== 0);
  const env = {
    ...process.env,
    HOME: home,
    ROSE_PREVIEW_PORT: '',
    ROSE_PREVIEW_URL: '',
    ROSE_PREVIEW_BACKEND_URL: baseUrl,
  };

  const before = await http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER);
  assert.equal(before.status, 200, JSON.stringify(before.data));
  assert.equal(before.data.status, 'not_running');
  assert.equal(before.data.preview_url, null);

  // A project session: the preview waits for this boot's startup report (--wait-startup).
  const projectDir = join(home, '.rose', 'project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'startup.json'), JSON.stringify({ timeoutS: 30 }));
  writeFileSync(join(projectDir, 'startup-report.json'), '{"status":"ok","boot":"previous"}');
  const startupDoneAfterMs = 1_500;
  const startupTimer = setTimeout(
    () => writeFileSync(join(projectDir, 'startup-report.json'), '{"status":"ok"}'),
    startupDoneAfterMs
  );
  const startedAt = Date.now();
  const start = await execFileAsync(
    cliPath,
    ['start', '--json', '--wait-startup', '--since', String(startedAt)],
    { env, timeout: 240_000 }
  );
  clearTimeout(startupTimer);
  const started = JSON.parse(start.stdout) as {
    pid: number;
    port: number;
    url: string;
    dir: string;
  };
  // If this test process is killed, never leave the dev server running.
  const stopOnSignal = () => {
    try {
      process.kill(-started.pid, 'SIGTERM');
    } catch {
      // already stopped
    }
    process.exit(143);
  };
  process.once('SIGTERM', stopOnSignal);
  process.once('SIGINT', stopOnSignal);
  const startMs = Date.now() - startedAt;
  assert.equal(started.dir, frontEnd, 'defaults to ~/workspace/front-end');
  assert.ok(startMs >= startupDoneAfterMs, `waited for this boot's startup report (${startMs} ms)`);
  console.log(
    `  rose-preview start (incl. ${startupDoneAfterMs} ms startup wait): ${startMs} ms (vite on ${started.port})`
  );
  let browser: Browser | null = null;
  try {
    // The status probe has a 2.5 s budget; vite's first response on a loaded host can
    // take longer, so read the status until the preview answers (bounded).
    const view = await retryWithBackoff(
      () => http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER),
      {
        maxRetries: 41,
        fixedDelays: Array<number>(40).fill(500),
        shouldRetryResult: (status) => status.status === 200 && status.data.status !== 'running',
        component: 'RosePreviewStartupFixture',
      }
    );
    assert.equal(view.status, 200, JSON.stringify(view.data));
    assert.equal(view.data.status, 'running');
    assert.equal(view.data.target, 'local');
    assert.equal(view.data.preview_url, `http://127.0.0.1:${started.port}/`);
    const previewUrl = String(view.data.preview_url);

    browser = await chromium.launch();
    const page = await browser.newPage();
    const loadAt = Date.now();
    await page.goto(new URL(HMR_EDIT_ROUTE, previewUrl).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 240_000,
    });
    await page.waitForFunction(
      `document.body.innerText.includes(${JSON.stringify(HMR_EDIT_TEXT)})`,
      undefined,
      { timeout: 240_000 }
    );
    console.log(`  first render (cold vite dep optimization): ${Date.now() - loadAt} ms`);
    await page.evaluate('window.__roseNoReload = 1');

    const file = join(frontEnd, HMR_EDIT_FILE);
    const original = readFileSync(file, 'utf8');
    assert.ok(original.includes(`>${HMR_EDIT_TEXT}<`), `${HMR_EDIT_FILE} renders ${HMR_EDIT_TEXT}`);
    const fs = localSandboxFs(home);
    const latencies: number[] = [];
    for (let i = 0; i < HMR_EDITS; i++) {
      const marker = `Rose in Rose ${i} ${randomUUID().slice(0, 8)}`;
      await armMarkerWatch(page, marker);
      const wroteAt = Date.now();
      await fs.writeFile(file, Buffer.from(original.replace(`>${HMR_EDIT_TEXT}<`, `>${marker}<`)));
      await page.waitForFunction('window.__roseSeenAt > 0', undefined, { timeout: 10_000 });
      latencies.push(Math.round(Number(await page.evaluate('window.__roseSeenAt')) - wroteAt));
      assert.equal(await page.evaluate('window.__roseNoReload'), 1, 'hot update, not a reload');
    }
    console.log(
      `  write→DOM latency ms: ${latencies.join(', ')} (p50 ${percentile(latencies, 50)}, max ${Math.max(...latencies)})`
    );
    for (const latency of latencies) {
      assert.ok(latency <= HMR_BUDGET_MS, `HMR took ${latency} ms (budget ${HMR_BUDGET_MS} ms)`);
    }
  } finally {
    await browser?.close();
    // The local-session close path: signal exactly the preview's process group.
    const stoppedByClose = stopLocalCodePreview(home);
    await execFileAsync(cliPath, ['stop'], { env, timeout: 30_000 });
    process.removeListener('SIGTERM', stopOnSignal);
    process.removeListener('SIGINT', stopOnSignal);
    assert.equal(stoppedByClose, true, 'session close stops the preview');
  }
  const stopped = await http('GET', `/api/claude-code-session/${taskId}/preview`, DEV_USER);
  assert.equal(stopped.data.status, 'not_running');
});

test('cloud wiring: ROSE_PREVIEW_URL + autostart only for dev sessions on the Rose repo', async () => {
  const runs: { cmd: string; envs?: Record<string, string> }[] = [];
  const sandbox = {
    sandboxId: 'sbxwire',
    commands: {
      run: async (cmd: string, opts?: { envs?: Record<string, string> }) => {
        runs.push({ cmd, envs: opts?.envs });
        return { exitCode: 0 };
      },
    },
  };
  const devEnvs: Record<string, string> = {
    ROSE_PREVIEW_PORT: '5173',
    ROSE_PREVIEW_BACKEND_URL: 'https://api.test',
  };
  assert.equal(
    applyPreviewUrlEnv(devEnvs, 'wss://3000-sbxwire.e2b.app', 'sbxwire'),
    'https://5173-sbxwire.e2b.app/'
  );
  assert.equal(devEnvs.ROSE_PREVIEW_URL, 'https://5173-sbxwire.e2b.app/');
  const plainEnvs: Record<string, string> = {};
  assert.equal(applyPreviewUrlEnv(plainEnvs, 'wss://3000-sbxwire.e2b.app', 'sbxwire'), null);
  assert.equal(plainEnvs.ROSE_PREVIEW_URL, undefined, 'non-dev sessions get no preview env');

  const launchedAt = Date.now() - 1234;
  assert.equal(
    await autostartRosePreview(sandbox, {
      envs: devEnvs,
      repoUrl: 'git@github.com:Rose-Ai-Labs/rose.git',
      launchedAt,
    }),
    true
  );
  assert.equal(runs.length, 1);
  assert.match(
    runs[0].cmd,
    /nohup \/home\/user\/\.rose\/bin\/rose-preview start --dir front-end --wait-startup/
  );
  const since = /--since "\$\(\( \$\(date \+%s%3N\) - (\d+) \)\)"/.exec(runs[0].cmd);
  assert.ok(
    since && Number(since[1]) >= 1234,
    `cutoff computed on the sandbox clock: ${runs[0].cmd}`
  );
  assert.equal(runs[0].envs?.ROSE_PREVIEW_URL, 'https://5173-sbxwire.e2b.app/');
  assert.equal(
    await autostartRosePreview(sandbox, {
      envs: devEnvs,
      repoUrl: 'https://github.com/someone/app',
      launchedAt,
    }),
    false,
    'other repos: the agent starts its own preview'
  );
  assert.equal(
    await autostartRosePreview(sandbox, {
      envs: plainEnvs,
      repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
      launchedAt,
    }),
    false,
    'non-dev sessions never autostart'
  );
  assert.equal(runs.length, 1);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface GithubCall {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

test('publish pushes the work branch and opens one PR against the merge target; never merges', async () => {
  const calls: GithubCall[] = [];
  let prs: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://github.test');
      const body = await readBody(req);
      calls.push({ method: req.method ?? 'GET', path: url.pathname + url.search, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && url.pathname === '/repos/Rose-Ai-Labs/rose/pulls') {
        if (prs.length > 0) {
          res.statusCode = 422;
          res.end(JSON.stringify({ message: 'A pull request already exists' }));
          return;
        }
        prs = [
          {
            number: 77,
            html_url: 'https://github.com/Rose-Ai-Labs/rose/pull/77',
            state: 'open',
            draft: false,
            merged_at: null,
          },
        ];
        res.statusCode = 201;
        res.end(JSON.stringify(prs[0]));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/repos/Rose-Ai-Labs/rose/pulls') {
        assert.equal(url.searchParams.get('head'), 'Rose-Ai-Labs:rose/ui-header');
        res.end(JSON.stringify(prs));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const savedApi = process.env.GITHUB_API_BASE_URL;
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const home = join(fixtureDir, 'publish-home');
  const origin = join(fixtureDir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const workspace = join(home, 'workspace');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['clone', '-q', origin, workspace], { stdio: 'ignore' });
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), 'rose\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-q', '-b', 'rose/ui-header');
  writeFileSync(join(workspace, 'header.txt'), 'sticky header\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'Make the header sticky');
  const head = git(workspace, 'rev-parse', 'HEAD');

  const agentId = await agentFor(DEV_USER);
  const session = await codeSessionRow(DEV_USER, agentId, {
    sandboxKind: 'local',
    homeDir: home,
    repoUrl: 'https://github.com/Rose-Ai-Labs/rose',
    branch: 'rose/ui-header',
    mergeTarget: 'main',
  });
  const taskId = await taskRow(agentId, {
    sandboxId: 'local',
    streamUrl: 'ws://127.0.0.1:9',
    codeSessionId: session.id,
  });
  try {
    const first = await publishOwnedTask(DEV_USER, taskId, {});
    assert.ok(first);
    assert.equal(first.created, true);
    assert.equal(first.merged, false);
    assert.equal(first.branch, 'rose/ui-header');
    assert.equal(first.base, 'main');
    assert.equal(first.head_sha, head);
    assert.equal(first.pr.number, 77);
    assert.equal(first.pr.url, 'https://github.com/Rose-Ai-Labs/rose/pull/77');
    assert.equal(
      git(origin, 'rev-parse', 'refs/heads/rose/ui-header'),
      head,
      'the work branch reached origin'
    );
    const createCall = calls.find((call) => call.method === 'POST');
    assert.equal(createCall?.body?.head, 'rose/ui-header');
    assert.equal(createCall?.body?.base, 'main');
    assert.equal(createCall?.body?.title, 'Make the header sticky', 'defaults to the last commit');
    assert.match(String(createCall?.body?.body), /\/deploy/);

    const again = await publishOwnedTask(DEV_USER, taskId, { title: 'Sticky header' });
    assert.ok(again);
    assert.equal(again.created, false, 'second publish returns the open PR');
    assert.equal(again.pr.number, 77);
    assert.ok(
      calls.every((call) => !/\/merge\b/.test(call.path) && call.method !== 'PUT'),
      'publish never calls a merge endpoint'
    );
    assert.equal(git(origin, 'rev-parse', 'refs/heads/main'), git(workspace, 'rev-parse', 'main'));

    git(workspace, 'checkout', '-q', 'main');
    await assert.rejects(
      publishOwnedTask(DEV_USER, taskId, {}),
      (error: unknown) => error instanceof CodePublishError && error.code === 'ON_MERGE_TARGET'
    );
    assert.equal(await publishOwnedTask(OTHER_USER, taskId, {}), null, 'foreign task → null (404)');
  } finally {
    if (savedApi === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = savedApi;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const repoless = await codeSessionRow(DEV_USER, agentId, { sandboxKind: 'local', homeDir: home });
  const repolessTask = await taskRow(agentId, {
    sandboxId: 'local',
    streamUrl: 'ws://127.0.0.1:9',
    codeSessionId: repoless.id,
  });
  const refused = await http(
    'POST',
    `/api/claude-code-session/${repolessTask}/publish`,
    DEV_USER,
    {}
  );
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.code, 'NOT_A_GITHUB_REPO');
});
