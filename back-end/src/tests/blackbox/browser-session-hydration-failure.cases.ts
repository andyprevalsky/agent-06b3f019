import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prisma } from '../../providers/database';
import {
  browserResumeScope,
  withBrowserResumeLifecycle,
  type ResumeLifecycleDependencies,
} from '../../providers/browser/resumeLifecycle';

// Captured at 18:00:36Z on 2026-10-28, after Kernel had allocated and bound
// the replacement. Payment setup had already completed successfully.
const hydrationFailure = 'page.goto: Timeout 30000ms exceeded';

export async function runBrowserHydrationFailureCases(): Promise<void> {
  const database = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(database.hostname));
  assert.match(database.pathname, /^\/victoria_[\w-]+$/);
  for (const scenario of [
    'known-failure',
    'release-unconfirmed',
    'still-live',
    'user-control',
    'changed-binding',
    'control-during-release',
    'reattached-source',
    'unknown-provider',
  ] as const) {
    const userId = `hydration-${randomUUID()}`;
    await prisma.user.create({ data: { userId, isAnonymous: true } });
    const context = await prisma.browserContext.create({ data: { userId } });
    const checkpointRef = `checkpoint-${randomUUID()}`;
    const session = await prisma.browserSession.create({
      data: {
        contextId: context.id,
        agentId: userId,
        logicalOwnerKey: `agent:${userId}`,
        provider: 'kernel',
        sessionId: `previous-${randomUUID()}`,
        status: 'PAUSED',
        checkpointRef,
      },
    });
    const operationKey = `steel-browser-task-lifecycle:${session.id}`;
    const nativeStates = new Map<string, string>();
    const released: string[] = [];
    let attempts = 0;
    let failedCandidate = '';
    const readBinding = () =>
      prisma.browserSession.findUniqueOrThrow({ where: { id: session.id } });
    const takeControl = () =>
      prisma.browserSession.update({
        where: { id: session.id },
        data: { controlState: 'USER', controlLeaseExpiresAt: new Date(Date.now() + 60_000) },
      });
    const deps: ResumeLifecycleDependencies<string> & {
      release(provider: string, id: string): Promise<boolean>;
      ended(id: string): Promise<boolean>;
    } = {
      readBinding,
      compatibility: 'default',
      reuseCompleted: true,
      sourceEnded: () => true,
      canFollow: async () => false,
      follow: async () => {
        throw new Error('failed hydration cannot be followed as ready');
      },
      inspect: async (_provider, marker) => {
        const id = `native-${marker}`;
        return nativeStates.has(id) ? { id, status: nativeStates.get(id)! } : null;
      },
      release: async (_provider, id) => {
        released.push(id);
        if (scenario === 'release-unconfirmed') return false;
        if (scenario !== 'still-live') nativeStates.set(id, 'deleted');
        if (scenario === 'control-during-release') await takeControl();
        return true;
      },
      ended: async (id) => nativeStates.get(id) === 'deleted',
      resume: async () => {
        attempts++;
        const scope = browserResumeScope()!;
        if (scenario === 'reattached-source' || scenario === 'unknown-provider') {
          const candidate =
            scenario === 'reattached-source' ? session.sessionId! : 'unattributed-native';
          await prisma.browserSession.update({
            where: { id: session.id },
            data: { sessionId: candidate },
          });
          await scope.beforeHydration(candidate);
          failedCandidate = candidate;
          throw new Error(hydrationFailure);
        }
        const intent = await scope.beforeCreate('kernel');
        const candidate = `native-${intent.marker}`;
        nativeStates.set(candidate, 'active');
        await prisma.browserSession.update({
          where: { id: session.id },
          data: { sessionId: candidate, status: 'PAUSED' },
        });
        await scope.beforeHydration(candidate);
        if (attempts === 1) {
          failedCandidate = candidate;
          if (scenario === 'user-control') await takeControl();
          if (scenario === 'changed-binding')
            await prisma.browserSession.update({
              where: { id: session.id },
              data: { sessionId: 'newer-binding' },
            });
          throw new Error(hydrationFailure);
        }
        return candidate;
      },
    };
    try {
      await assert.rejects(withBrowserResumeLifecycle(session.id, deps), /page\.goto/);
      const ledger = await prisma.toolSideEffect.findUniqueOrThrow({
        where: { operationKey },
      });
      const afterFailure = await readBinding();
      assert.equal(afterFailure.checkpointRef, checkpointRef, 'the saved checkpoint survives');
      assert.equal(afterFailure.status, 'PAUSED', 'partial hydration must not publish ACTIVE');
      if (scenario === 'known-failure') {
        assert.equal(
          ledger.status,
          'RELEASED',
          'completed failed hydration must not retain in-flight custody'
        );
        assert.deepEqual(released, [failedCandidate]);
        assert.equal(nativeStates.get(failedCandidate), 'deleted');
        const replacement = await withBrowserResumeLifecycle(session.id, deps);
        assert.notEqual(replacement, failedCandidate);
        const ready = await readBinding();
        assert.equal(ready.id, session.id, 'the logical browser identity survives');
        assert.equal(ready.status, 'ACTIVE');
        assert.equal(ready.sessionId, replacement);
        assert.equal(ready.checkpointRef, checkpointRef);
        assert.equal(attempts, 2);
      } else {
        assert.equal(ledger.status, 'STARTED', `${scenario} must remain fenced`);
        assert.equal(attempts, 1);
        if (
          ['user-control', 'changed-binding', 'reattached-source', 'unknown-provider'].includes(
            scenario
          )
        )
          assert.deepEqual(released, [], 'do not close a candidate whose ownership changed');
        if (scenario === 'user-control' || scenario === 'control-during-release')
          assert.equal(afterFailure.controlState, 'USER');
        if (scenario === 'changed-binding') assert.equal(afterFailure.sessionId, 'newer-binding');
      }
      process.stdout.write(`PASS failed hydration: ${scenario}\n`);
    } finally {
      await prisma.toolSideEffect.deleteMany({ where: { operationKey } });
      await prisma.browserContext.delete({ where: { id: context.id } });
      await prisma.user.delete({ where: { userId } });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBrowserHydrationFailureCases()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
