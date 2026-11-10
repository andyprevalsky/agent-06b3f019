/**
 * Code-sessions case for the code-agents list (W5b UI contract), run inside
 * code-sessions.blackbox.ts with its fake E2B sandbox and running backend:
 *
 *   closeClaudeCodeSession(reason) ──► ClaudeCodeSession.closeReason
 *   GET /api/agents/code-agents ──► PAUSED for the newest task of a live
 *                                   session that closed resumably, plus
 *                                   code_session_id and awaiting_parent
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { closeClaudeCodeSession } from '../../providers/e2bCloseSession';
import { CODE_SANDBOX_IDLE_TIMEOUT_MS } from '../../providers/e2bCodeSessionSandbox';

export interface CodeSessionListContext {
  userA: string;
  fixtureDir: string;
  http: (
    method: string,
    path: string,
    userId: string
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
  seedWorkspace: (home: string) => unknown;
  fakeSandbox: (home: string, sandboxId: string) => { sandbox: Sandbox };
  patchConnect: (impl: (id: string) => Promise<Sandbox>) => void;
  restoreConnect: () => void;
}

export async function testResumableCloseListsPaused(ctx: CodeSessionListContext): Promise<void> {
  const root = randomUUID();
  await prisma.agent.create({
    data: { id: root, userId: ctx.userA, busId: root, goal: 'List the code sessions' },
  });
  const home = join(ctx.fixtureDir, 'home-list');
  ctx.seedWorkspace(home);
  const sandboxId = `sb-${randomUUID()}`;
  const codeSession = await prisma.codeSession.create({
    data: {
      userId: ctx.userA,
      rootAgentId: root,
      ownerAgentId: root,
      repoKey: `list-${randomUUID()}`,
      branch: 'rose/feature-1',
      sandboxKind: 'e2b',
      sandboxId,
    },
  });
  const start = Date.now() - 60_000;
  const newTask = (offsetMs: number) =>
    prisma.claudeCodeSession.create({
      data: {
        agentId: root,
        sandboxId,
        goal: 'g',
        codeSessionId: codeSession.id,
        createdAt: new Date(start + offsetMs),
      },
    });
  const list = async () => {
    const res = await ctx.http('GET', `/api/agents/code-agents?root_ids=${root}`, ctx.userA);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const items = res.data.code_agents as Array<Record<string, unknown>>;
    return new Map(items.map((item) => [item.code_agent_id, item]));
  };
  const fake = ctx.fakeSandbox(home, sandboxId);
  ctx.patchConnect(async () => fake.sandbox);
  try {
    let items: Map<unknown, Record<string, unknown>>;
    const asked = await newTask(0);
    // A running task's container is awake while its keepalive is within E2B's idle window.
    assert.equal((await list()).get(asked.id)?.container_state, 'awake');
    // E2B pauses an idle sandbox itself without touching CodeSession.state: an ACTIVE
    // session whose last keepalive is older than the idle timeout is stopped, not awake.
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { lastActiveAt: new Date(Date.now() - CODE_SANDBOX_IDLE_TIMEOUT_MS - 60_000) },
    });
    assert.equal((await list()).get(asked.id)?.container_state, 'stopped');
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { lastActiveAt: new Date() },
    });
    assert.equal((await list()).get(asked.id)?.container_state, 'awake');
    await closeClaudeCodeSession(asked.id, ctx.userA, root, [], { reason: 'idle' });
    const askedRow = await prisma.claudeCodeSession.findUniqueOrThrow({ where: { id: asked.id } });
    assert.equal(askedRow.status, 'CLOSED', 'the task row itself stays CLOSED for the chip');
    assert.equal(askedRow.closeReason, 'idle', 'the close records its reason');
    const paused = (await list()).get(asked.id);
    assert.equal(paused?.status, 'PAUSED', JSON.stringify(paused));
    assert.equal(paused?.code_session_id, codeSession.id);
    assert.equal(paused?.awaiting_parent, null, 'code agents ask no questions');
    // The close pauses the session's sandbox: stopped, resumable on the next message.
    assert.equal(paused?.container_state, 'stopped', JSON.stringify(paused));
    // A resume leases the session (ACTIVE, fresh keepalive) before its sandbox
    // connects: the ended task's row stays stopped; only a running task reads awake.
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { state: 'ACTIVE', lastActiveAt: new Date() },
    });
    assert.equal((await list()).get(asked.id)?.container_state, 'stopped');
    // A later spawn attached to the same live sandbox (same code session, new task):
    // the ended task's container is that running one, awake for both rows.
    const attached = await newTask(500);
    items = await list();
    assert.equal(items.get(asked.id)?.container_state, 'awake', 'a sibling task runs in it');
    assert.equal(items.get(attached.id)?.container_state, 'awake');
    await prisma.claudeCodeSession.delete({ where: { id: attached.id } });
    await prisma.codeSession.update({ where: { id: codeSession.id }, data: { state: 'PAUSED' } });

    // The next spawn resumes the session as a new task; a finished task is not a pause.
    const answered = await newTask(1000);
    await closeClaudeCodeSession(answered.id, ctx.userA, root, [], { reason: 'close' });
    items = await list();
    assert.equal(items.get(asked.id)?.status, 'CLOSED', 'a superseded pause lists as closed');
    assert.equal(items.get(answered.id)?.status, 'CLOSED', 'a normal close is not a pause');

    const failed = await newTask(2000);
    await closeClaudeCodeSession(failed.id, ctx.userA, root, [], { reason: 'failure' });
    assert.equal((await list()).get(failed.id)?.status, 'CLOSED', 'a failure is not a pause');

    for (const [offset, reason] of [
      [3000, 'idle'],
      [4000, 'cancel'],
      [5000, 'usage_limit'],
    ] as const) {
      const resumable = await newTask(offset);
      await closeClaudeCodeSession(resumable.id, ctx.userA, root, [], { reason });
      items = await list();
      assert.equal(items.get(resumable.id)?.status, 'PAUSED', `${reason} is resumable`);
      assert.equal(items.get(resumable.id)?.awaiting_parent, null, `${reason} asked nothing`);
    }
    const latest = [...(await list()).values()][0];
    await prisma.codeSession.update({
      where: { id: codeSession.id },
      data: { state: 'RETIRED', retiredAt: new Date() },
    });
    assert.equal(
      (await list()).get(String(latest.code_agent_id))?.status,
      'CLOSED',
      'a retired session is not resumable'
    );
    // A retired session's sandbox is gone, for every task of it.
    for (const item of (await list()).values()) {
      assert.equal(item.container_state, 'destroyed', JSON.stringify(item));
    }
    // Without a persistent session (Mac and legacy runs) the container is unknown.
    const legacy = await prisma.claudeCodeSession.create({
      data: { agentId: root, sandboxId: `sb-${randomUUID()}`, goal: 'g', status: 'CLOSED' },
    });
    assert.equal((await list()).get(legacy.id)?.container_state, null);
  } finally {
    ctx.restoreConnect();
    await prisma.claudeCodeSession.deleteMany({ where: { agentId: root } });
  }
}
