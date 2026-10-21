import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { prisma } from '../../providers/database';
import { AGENT_GRAPH_CLI_SCRIPT } from '../../providers/agentGraph/cli';

import { mintAgentGraphToken } from '../../providers/agentGraph/token';

import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { agentToolsCliScript } from '../../providers/agentTools/workspace';
import { keepAliveCodeTask } from '../../providers/codeSessions/spawn';

/**
 * Adversarial agent-graph scenarios (L-A2A-ADV, Rose-builds-Rose): question
 * routing and A2A delivery under deadlock, retry, flood and isolation pressure.
 * Runs inside agent-graph.blackbox.ts with its own fixture (no LLM calls; the
 * shipped `rose` / `rose-agents` CLIs run as real node processes).
 *
 *   user X, tree R:  R ─┬─ C ─── G            user X, tree R3: R3 ── S3x
 *                       │  ├ SC (code)  └ SG   user Y, tree RY: RY ── SY
 *                       │  └ SCold (code, CLOSED: an earlier task of SC's session)
 *                       ├─ A1 ── SX (code)    corrupt parent cycle: L1 ⇄ L2
 *                       ├─ B1
 *                       ├─ F  (COMPLETED) ── SF (code)
 *                       ├─ D  (deleted)   ── SD (code)
 *                       ├─ P  ── SP (code)
 *                       ├─ T  (dedupe target)
 *                       └─ SR (code, root-spawned)
 *
 * Every case asserts: no deadlock (each call returns within a bound), no lost
 * message, no duplicate side effect, routing to the right agent, and a bounded
 * footprint.
 */
export const execFileAsync = promisify(execFile);

export interface AdversarialContext {
  baseUrl: string;
  apiKey: string;
}

export interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

export const RUN = randomUUID().slice(0, 8);
export const userX = `a2a-adv-x-${RUN}`;
export const userY = `a2a-adv-y-${RUN}`;
export const agentIds = {
  R: randomUUID(),
  C: randomUUID(),
  G: randomUUID(),
  A1: randomUUID(),
  B1: randomUUID(),
  F: randomUUID(),
  D: randomUUID(),
  P: randomUUID(),
  T: randomUUID(),
  R3: randomUUID(),
  RY: randomUUID(),
  L1: randomUUID(),
  L2: randomUUID(),
};
export const sessionIds = {
  SC: randomUUID(),
  SCold: randomUUID(),
  SG: randomUUID(),
  SX: randomUUID(),
  SF: randomUUID(),
  SD: randomUUID(),
  SP: randomUUID(),
  SR: randomUUID(),
  S3x: randomUUID(),
  SY: randomUUID(),
};
export const ids = { ...agentIds, ...sessionIds };

/** Every graph call must answer well inside this bound (no hang, no deadlock). */
export const CALL_BOUND_MS = 10_000;

export async function call(
  ctx: AdversarialContext,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    bearer?: string;
    agentId?: string;
    codeSessionId?: string;
    userId?: string;
  } = {}
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.bearer !== undefined) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.agentId !== undefined || init.userId !== undefined) headers['X-API-Key'] = ctx.apiKey;
  if (init.agentId !== undefined) headers['X-Agent-Id'] = init.agentId;
  if (init.codeSessionId !== undefined) headers['X-Code-Session-Id'] = init.codeSessionId;
  if (init.userId !== undefined) headers['X-User-Id'] = init.userId;
  const started = Date.now();
  const response = await fetch(`${ctx.baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(CALL_BOUND_MS),
  });
  const text = await response.text();
  assert(Date.now() - started < CALL_BOUND_MS, `${path} took ${Date.now() - started}ms`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers };
}

export function graphToken(
  sessionId: string,
  ownerAgentId: string,
  options: {
    rootAgentId?: string;
    userId?: string;
    ttlSeconds?: number;
    nowSeconds?: number;
  } = {}
): string {
  return mintAgentGraphToken(
    {
      sub: options.userId ?? userX,
      rootAgentId: options.rootAgentId ?? ids.R,
      ownerAgentId,
      sessionId,
      provider: 'claude',
    },
    {
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.nowSeconds !== undefined ? { nowSeconds: options.nowSeconds } : {}),
    }
  ).token;
}

export function tokenClaims(token: string): {
  sessionId: string;
  exp: number;
  rootAgentId: string;
} {
  return JSON.parse(Buffer.from(token.slice(4).split('.')[0], 'base64url').toString('utf8')) as {
    sessionId: string;
    exp: number;
    rootAgentId: string;
  };
}

/** USER rows on `agentId` that came over the agent graph from `senderId`. */
export async function a2aRowsFrom(agentId: string, senderId: string) {
  return prisma.message.findMany({
    where: { agentId, role: 'USER', metadata: { path: ['a2a', 'from', 'id'], equals: senderId } },
    orderBy: { timestamp: 'asc' },
  });
}

/** Every USER row on `agentId` that arrived over the agent graph. */
export async function a2aRowCount(agentId: string): Promise<number> {
  const rows = await prisma.message.findMany({
    where: { agentId, role: 'USER' },
    select: { metadata: true },
  });
  return rows.filter((row) => {
    const metadata = row.metadata as Record<string, unknown> | null;
    return typeof metadata?.a2a === 'object' && metadata.a2a !== null;
  }).length;
}

export async function awaitingParent(sessionId: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.claudeCodeSession.findUnique({
    where: { id: sessionId },
    select: { awaitingParent: true },
  });
  return (row?.awaitingParent ?? null) as Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export async function seedAdversarial(): Promise<void> {
  await prisma.user.create({ data: { userId: userX, name: 'A2A adversarial X' } });
  await prisma.user.create({ data: { userId: userY, name: 'A2A adversarial Y' } });
  const agent = (
    id: string,
    userId: string,
    parentAgentId: string | null,
    busId: string,
    extra: { status?: 'ACTIVE' | 'COMPLETED'; deletedAt?: Date } = {}
  ) =>
    prisma.agent.create({
      data: {
        id,
        userId,
        parentAgentId,
        busId,
        goal: `goal ${id}`,
        status: extra.status ?? 'ACTIVE',
        temporalWorkflowId: id,
        parentWorkflowId: parentAgentId,
        ...(extra.deletedAt !== undefined ? { deletedAt: extra.deletedAt } : {}),
      },
    });
  const { R, C, G, A1, B1, F, D, P, T, R3, RY, L1, L2 } = agentIds;
  await agent(R, userX, null, R);
  await agent(C, userX, R, R);
  await agent(G, userX, C, R);
  await agent(A1, userX, R, R);
  await agent(B1, userX, R, R);
  await agent(F, userX, R, R, { status: 'COMPLETED' });
  await agent(D, userX, R, R, { deletedAt: new Date() });
  await agent(P, userX, R, R);
  await agent(T, userX, R, R);
  await agent(R3, userX, null, R3);
  await agent(RY, userY, null, RY);
  await agent(L1, userX, null, L1);
  await agent(L2, userX, L1, L1);
  // Corrupt data: a parent-link cycle L1 ⇄ L2.
  await prisma.agent.update({ where: { id: L1 }, data: { parentAgentId: L2 } });

  const session = (id: string, agentId: string, status: 'ACTIVE' | 'CLOSED' = 'ACTIVE') =>
    prisma.claudeCodeSession.create({
      data: {
        id,
        agentId,
        sandboxId: `sb-${id}`,
        streamUrl: 'ws://127.0.0.1:9/unused',
        goal: `code ${id}`,
        status,
        codeProvider: 'claude',
      },
    });
  await session(sessionIds.SC, C);
  await session(sessionIds.SCold, C, 'CLOSED');
  await session(sessionIds.SG, G);
  await session(sessionIds.SX, A1);
  await session(sessionIds.SF, F);
  await session(sessionIds.SD, D);
  await session(sessionIds.SP, P);
  await session(sessionIds.SR, R);
  await session(sessionIds.S3x, R3);
  await session(sessionIds.SY, RY);
}

export async function cleanupAdversarial(): Promise<void> {
  const agents = Object.values(agentIds);
  await prisma.claudeCodeSession.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.message.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.agentAttentionRequest.deleteMany({ where: { agentId: { in: agents } } });
  await prisma.agent.updateMany({ where: { id: { in: agents } }, data: { parentAgentId: null } });
  await prisma.agent.deleteMany({ where: { id: { in: agents } } });
  await prisma.user.deleteMany({ where: { userId: { in: [userX, userY] } } });
}

// ---------------------------------------------------------------------------
// Shipped CLIs
// ---------------------------------------------------------------------------

export interface CliHome {
  home: string;
  roseAgents: string;
  rose: string;
  cleanup: () => void;
}

export function cliHome(): CliHome {
  const home = mkdtempSync(join(tmpdir(), 'a2a-adv-'));
  mkdirSync(join(home, '.rose', 'bin'), { recursive: true });
  const roseAgents = join(home, '.rose', 'bin', 'rose-agents');
  const rose = join(home, '.rose', 'bin', 'rose');
  writeFileSync(roseAgents, AGENT_GRAPH_CLI_SCRIPT, { mode: 0o755 });
  writeFileSync(rose, agentToolsCliScript(), { mode: 0o755 });
  return { home, roseAgents, rose, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function cliEnv(ctx: AdversarialContext, home: string, extra: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ROSE_AGENTS_URL: `${ctx.baseUrl}/api/agent-graph`,
    ROSE_TOOLS_WAIT_SECONDS: '2',
    // These cases exercise pinned questions in a Rose Desktop session.
    ROSE_TOOLS_ROSE_DESKTOP: '1',
    ...extra,
  };
  delete env.ROSE_TOOLS_CONFIG;
  return env;
}

export async function runCli(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [file, ...args], {
      env,
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// 1. A code agent asks its spawning sub-agent, which is blocked on its spawn
// ---------------------------------------------------------------------------

export async function testQuestionToBlockedSpawnerIsHandedOver(
  ctx: AdversarialContext
): Promise<void> {
  const cli = cliHome();
  try {
    const env = cliEnv(ctx, cli.home, {
      ROSE_TOOLS_URL: `${ctx.baseUrl}/api/agent-tools/${ids.C}`,
      ROSE_TOOLS_TOKEN: mintAgentToolsToken(userX, ids.C, {
        provider: 'claude',
        taskId: ids.SC,
      }).token,
      ROSE_AGENTS_TOKEN: graphToken(ids.SC, ids.C),
    });
    const question = `Postgres or SQLite ${RUN}?`;
    const args = [
      'display',
      '--pinned',
      '--caption',
      question,
      '--option',
      'Postgres | matches prod',
      '--option',
      'SQLite',
    ];
    const before = {
      R: await a2aRowCount(ids.R),
      G: await a2aRowCount(ids.G),
      attention: await prisma.agentAttentionRequest.count({ where: { agentId: ids.C } }),
    };
    const started = Date.now();
    const first = await runCli(cli.rose, args, env);
    assert(first.code === 0, `rose display exits 0: ${first.stderr} ${first.stdout}`);
    assert(Date.now() - started < 20_000, 'the CLI never blocks on the blocked spawner');
    assert(first.stdout.includes(`Asked agent ${ids.C}`), `asked the spawner: ${first.stdout}`);

    const rows = await a2aRowsFrom(ids.C, ids.SC);
    assert(rows.length === 1, `one question on the spawner, got ${rows.length}`);
    const a2a = (rows[0].metadata as { a2a: { kind: string; message_id: string } }).a2a;
    assert(a2a.kind === 'question', 'delivered as a question');
    assert(
      (await a2aRowCount(ids.R)) === before.R && (await a2aRowCount(ids.G)) === before.G,
      'nothing leaks to other levels of the tree'
    );
    assert(
      (await prisma.agentAttentionRequest.count({ where: { agentId: ids.C } })) ===
        before.attention,
      'an agent-routed question stores no user pin'
    );
    const marked = await awaitingParent(ids.SC);
    assert(
      marked?.message_id === a2a.message_id && marked.question === question,
      `the code session is marked for the blocked spawn: ${JSON.stringify(marked)}`
    );
    // The spawn blocked on SC sees the question on its next keepalive.
    const extended: string[] = [];
    const keepalive = await keepAliveCodeTask(ids.SC, async (sandboxId) => {
      extended.push(sandboxId);
    });
    assert(keepalive.alive, 'the attached spawn keeps the session');
    assert(
      keepalive.awaiting_parent?.message_id === a2a.message_id &&
        keepalive.awaiting_parent.question === question,
      `keepalive hands the question to the spawn: ${JSON.stringify(keepalive)}`
    );
    assert(extended.length === 1, 'one sandbox keepalive per call');

    // Re-running the same question (an interrupted CLI) never asks twice.
    const again = await runCli(cli.rose, args, env);
    assert(again.code === 0, `re-run exits 0: ${again.stderr}`);
    assert((await a2aRowsFrom(ids.C, ids.SC)).length === 1, 'still one question after a re-run');
    assert(
      (await awaitingParent(ids.SC))?.message_id === a2a.message_id,
      'the mark keeps the same message id'
    );
  } finally {
    cli.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 2. A ⇄ B mutual questions between siblings, and a corrupt parent cycle
// ---------------------------------------------------------------------------
