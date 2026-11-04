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

  test('stack teardown kills exactly the sandboxes tagged with this stack; the reaper kills only attributable orphans', async () => {
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
    const mine = (
      codeSessionId: string | null,
      sandboxId: string,
      state: 'running' | 'paused' = 'paused'
    ): Listed => ({
      sandboxId,
      state,
      startedAt: old,
      metadata: {
        roseOrigin,
        roseStack,
        ...(codeSessionId !== null ? { codeSessionId } : {}),
      },
    });
    const listing: Listed[] = [
      mine(live.id, live.sandboxId ?? ''), // live session's own sandbox: keep
      mine(retired.id, retired.sandboxId ?? ''), // RETIRED row: reap
      mine(randomUUID(), `sb-${randomUUID()}`), // row gone from this stack's DB: reap
      mine(live.id, `sb-superseded-${randomUUID()}`), // superseded paused sandbox: reap
      mine(null, `sb-untagged-session-${randomUUID()}`), // no session tag: keep
      {
        sandboxId: `sb-foreign-${randomUUID()}`,
        state: 'paused',
        startedAt: old,
        metadata: { roseOrigin: 'other', roseStack: 'other-stack', codeSessionId: retired.id },
      }, // another stack: keep
      {
        sandboxId: `sb-legacy-${randomUUID()}`,
        state: 'paused',
        startedAt: old,
        metadata: { createRequestId: 'x' },
      }, // untagged: keep
    ];
    const killed: string[] = [];
    const deps = {
      list: async (metadata: Record<string, string>) =>
        listing.filter((item) =>
          Object.entries(metadata).every(([key, value]) => item.metadata[key] === value)
        ),
      kill: async (sandboxId: string) => {
        killed.push(sandboxId);
      },
    };
    try {
      const summary = await mod.reapOrphanedCodeSandboxes(deps, { maxSandboxes: 50 });
      assert.deepEqual(
        new Set(killed),
        new Set([listing[1].sandboxId, listing[2].sandboxId, listing[3].sandboxId]),
        'only this stack’s sandboxes whose session is gone, RETIRED or superseded'
      );
      assert.equal(summary.reaped, 3);

      killed.splice(0);
      assert.equal(await mod.killStackSandboxes(deps), 5);
      assert.deepEqual(
        new Set(killed),
        new Set(listing.slice(0, 5).map((item) => item.sandboxId)),
        'teardown kills every sandbox of this stack and nothing else'
      );
    } finally {
      await prisma.codeSession.deleteMany({ where: { id: { in: [live.id, retired.id] } } });
    }
  });
}
