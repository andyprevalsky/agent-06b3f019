/**
 * Sandbox attribution cases (T3), run inside code-sessions.blackbox.ts:
 *
 *   create ──► every E2B sandbox carries roseOrigin + roseStack (+ session ids for code sessions)
 *   stack teardown ──► kills exactly the sandboxes tagged with this stack
 *   orphan reaper  ──► kills only this stack's sandboxes whose session row is gone or RETIRED
 *
 * E2B is faked at the SDK statics; nothing reaches E2B.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Sandbox } from 'e2b';
import { prisma } from '../../providers/database';
import { createSandboxWithRetry } from '../../providers/e2bSandboxCreate';
import { acquireCodeSandbox } from '../../providers/e2bCodeSessionSandbox';

interface Listed {
  sandboxId: string;
  state: 'running' | 'paused';
  metadata: Record<string, string>;
  startedAt: Date;
}

type ReaperModule = {
  roseSandboxIdentity: () => { roseOrigin: string; roseStack: string };
  killStackSandboxes: (deps?: unknown) => Promise<number>;
  reapOrphanedCodeSandboxes: (
    deps?: unknown,
    opts?: { maxSandboxes?: number; now?: Date }
  ) => Promise<{ scanned: number; reaped: number }>;
};

async function reaper(): Promise<ReaperModule> {
  const create =
    (await import('../../providers/e2bSandboxCreate')) as unknown as Partial<ReaperModule>;
  const reap = (await import('../../providers/codeSessions/sandboxReaper').catch(
    () => ({})
  )) as Partial<ReaperModule>;
  assert.equal(typeof create.roseSandboxIdentity, 'function', 'sandboxes need a stack identity');
  assert.equal(typeof reap.killStackSandboxes, 'function', 'stack teardown must exist');
  assert.equal(typeof reap.reapOrphanedCodeSandboxes, 'function', 'orphan reaper must exist');
  return { ...create, ...reap } as ReaperModule;
}

export function registerSandboxAttributionCases(userId: string): void {
  test('every E2B sandbox is created with attributable metadata (origin, stack, code session ids)', async (t) => {
    const created: Array<Record<string, string>> = [];
    t.mock.method(
      Sandbox,
      'create',
      async (_template: string, opts: { metadata?: Record<string, string> }) => {
        created.push({ ...(opts.metadata ?? {}) });
        return { sandboxId: `sb-attr-${randomUUID()}` } as unknown as Sandbox;
      }
    );
    await createSandboxWithRetry('tmpl', { apiKey: 'k' }, 'attr');
    const agentId = randomUUID();
    const session = await prisma.codeSession.create({
      data: {
        userId,
        rootAgentId: agentId,
        ownerAgentId: agentId,
        repoKey: `attr-${randomUUID()}`,
      },
    });
    try {
      await acquireCodeSandbox({ ...session }, 'tmpl', {}, 'attr');
    } finally {
      await prisma.codeSession.delete({ where: { id: session.id } });
    }
    for (const metadata of created) {
      assert.ok(metadata.roseOrigin, `roseOrigin tag missing: ${JSON.stringify(metadata)}`);
      assert.ok(metadata.roseStack, `roseStack tag missing: ${JSON.stringify(metadata)}`);
    }
    assert.equal(created.length, 2);
    assert.equal(created[1].codeSessionId, session.id);
    assert.equal(created[1].ownerAgentId, agentId);
    assert.equal(created[1].userId, userId);
    assert.equal(created[1].rootAgentId, agentId);
  });

  test('stack identity never borrows the production Render origin off a laptop .env', async () => {
    const mod = await reaper();
    const saved = { render: process.env.RENDER, service: process.env.RENDER_SERVICE_ID };
    try {
      process.env.RENDER_SERVICE_ID = 'srv-prod';
      delete process.env.RENDER;
      assert.match(mod.roseSandboxIdentity().roseOrigin, /^host:/);
      process.env.RENDER = 'true';
      assert.equal(mod.roseSandboxIdentity().roseOrigin, 'render:srv-prod');
    } finally {
      for (const [key, value] of [
        ['RENDER', saved.render],
        ['RENDER_SERVICE_ID', saved.service],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('stack identity is unique per workspace on a shared host+db, and unchanged on Render or with an explicit id', async () => {
    const mod = await reaper();
    const keys = [
      'RENDER',
      'RENDER_SERVICE_ID',
      'CONDUCTOR_WORKSPACE_NAME',
      'ROSE_SANDBOX_STACK_ID',
      'ROSE_SANDBOX_ORIGIN',
    ] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) delete process.env[key];
      const bare = mod.roseSandboxIdentity().roseStack;
      assert.doesNotMatch(bare, /\|ws:/);
      process.env.CONDUCTOR_WORKSPACE_NAME = 'devbox-a';
      const a = mod.roseSandboxIdentity().roseStack;
      process.env.CONDUCTOR_WORKSPACE_NAME = 'devbox-b';
      const b = mod.roseSandboxIdentity().roseStack;
      assert.match(a, /\|ws:devbox-a\|db:/);
      assert.notEqual(a, b, 'two workspaces on one host+db must not share a stack id');
      process.env.ROSE_SANDBOX_STACK_ID = 'explicit-stack';
      assert.equal(mod.roseSandboxIdentity().roseStack, 'explicit-stack');
      delete process.env.ROSE_SANDBOX_STACK_ID;
      process.env.RENDER = 'true';
      process.env.RENDER_SERVICE_ID = 'srv-prod';
      assert.doesNotMatch(mod.roseSandboxIdentity().roseStack, /\|ws:/);
      assert.match(mod.roseSandboxIdentity().roseStack, /^render:srv-prod\|db:/);
    } finally {
      for (const key of keys) {
        const value = saved[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('stack teardown kills only this stack’s sandboxes recorded in its database; the reaper kills only attributable orphans, page by page', async () => {
    const mod = await reaper();
    const { roseStack, roseOrigin } = mod.roseSandboxIdentity();
    const agentId = randomUUID();
    const mk = async (state: 'ACTIVE' | 'PAUSED' | 'RETIRED') =>
      prisma.codeSession.create({
        data: {
          userId,
          rootAgentId: agentId,
          ownerAgentId: agentId,
          repoKey: `reap-${randomUUID()}`,
          state,
          sandboxKind: 'e2b',
          sandboxId: `sb-${randomUUID()}`,
        },
      });
    const live = await mk('PAUSED');
    const retired = await mk('RETIRED');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const young = new Date(Date.now() - 5 * 60 * 1000);
    const mine = (
      codeSessionId: string | null,
      sandboxId: string,
      state: 'running' | 'paused' = 'paused',
      startedAt = old
    ): Listed => ({
      sandboxId,
      state,
      startedAt,
      metadata: { roseOrigin, roseStack, ...(codeSessionId !== null ? { codeSessionId } : {}) },
    });
    const listing: Listed[] = [
      mine(live.id, live.sandboxId ?? ''), // 0 live session's own sandbox: keep
      mine(retired.id, retired.sandboxId ?? ''), // 1 RETIRED row: reap
      mine(randomUUID(), `sb-${randomUUID()}`), // 2 row gone: reap
      mine(live.id, `sb-superseded-${randomUUID()}`), // 3 superseded, paused, old: reap
      mine(live.id, `sb-young-${randomUUID()}`, 'paused', young), // 4 maybe mid-restore: keep
      mine(live.id, `sb-running-${randomUUID()}`, 'running'), // 5 running: keep
      mine(null, `sb-untagged-session-${randomUUID()}`), // 6 no session tag: keep
      {
        sandboxId: `sb-foreign-${randomUUID()}`,
        state: 'paused',
        startedAt: old,
        metadata: { roseOrigin: 'other', roseStack: 'other-stack', codeSessionId: retired.id },
      }, // 7 another stack: keep
      {
        sandboxId: `sb-legacy-${randomUUID()}`,
        state: 'paused',
        startedAt: old,
        metadata: { createRequestId: 'x' },
      }, // 8 untagged: keep
    ];
    const killed: string[] = [];
    const gone = new Set<string>(); // E2B no longer lists a killed sandbox
    const pageSize = 2;
    const deps = {
      list: async (metadata: Record<string, string>, limit: number, cursor?: string | null) => {
        const matching = listing.filter(
          (item) =>
            !gone.has(item.sandboxId) &&
            Object.entries(metadata).every(([key, value]) => item.metadata[key] === value)
        );
        const start = Number(cursor ?? 0);
        const end = Math.min(start + Math.min(limit, pageSize), matching.length);
        return {
          items: matching.slice(start, end),
          nextCursor: end < matching.length ? String(end) : null,
        };
      },
      kill: async (sandboxId: string) => {
        killed.push(sandboxId);
        gone.add(sandboxId);
      },
    };
    try {
      // Each tick reads one bounded page and continues where the last tick stopped.
      let cursor: string | null = null;
      let reaped = 0;
      for (let tick = 0; tick < 6; tick += 1) {
        const summary = (await (
          mod.reapOrphanedCodeSandboxes as unknown as (
            d: unknown,
            o: unknown
          ) => Promise<{ reaped: number; nextCursor: string | null }>
        )(deps, { maxSandboxes: pageSize, cursor })) as {
          reaped: number;
          nextCursor: string | null;
        };
        reaped += summary.reaped;
        cursor = summary.nextCursor;
      }
      assert.deepEqual(
        new Set(killed),
        new Set([listing[1].sandboxId, listing[2].sandboxId, listing[3].sandboxId]),
        'only this stack’s old paused sandboxes whose session is gone, RETIRED or superseded'
      );
      assert.equal(reaped, 3);

      killed.splice(0);
      gone.clear();
      assert.equal(await mod.killStackSandboxes(deps), 2);
      assert.deepEqual(
        new Set(killed),
        new Set([listing[0].sandboxId, listing[1].sandboxId]),
        'teardown kills only sandboxes this stack’s database recorded'
      );
    } finally {
      await prisma.codeSession.deleteMany({ where: { id: { in: [live.id, retired.id] } } });
    }
  });
}
