/**
 * One resume may issue a second provider create only after a definite rejection.
 *
 * Regression (whole-devbox deploy, 2026-10-26): Kernel answered a resume create on
 * a deleted proxy with HTTP 400 "proxy not found"; the provider re-resolved the same
 * location and created again inside the same resume, but custody refused that second
 * create ("requires reconciliation before retry") although the first allocated
 * nothing. An uncertain create (transport failure) must still block a second POST.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  browserResumeScope,
  resumeNativeCreate,
  withBrowserResumeLifecycle,
} from '../../providers/steel/lifecycleClaim';
import { steelEnvironmentIdentity } from '../../providers/steel/sessionIdentity';
import { recreateSession } from '../../providers/steel/sessionResume';
import type { ResumeLifecycleDependencies } from '../../providers/browser/resumeLifecycle';
import type { Browser } from 'playwright';

/** A verified released failed candidate can retry; unknown native outcomes cannot. */
export async function runBrowserSettledSteelResumeCases(): Promise<void> {
  const db = new URL(process.env.DATABASE_URL!);
  assert(['localhost', '127.0.0.1'].includes(db.hostname));
  assert.match(db.pathname, /^\/victoria_[\w-]+$/);
  const userId = `settled-steel-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const context = await prisma.browserContext.create({ data: { userId } });
  const keys = new Set<string>();
  const states = new Map<string, string>();
  let creates = 0,
    releases = 0;
  const row = await prisma.browserSession.create({
    data: {
      contextId: context.id,
      agentId: randomUUID(),
      provider: 'steel',
      sessionId: randomUUID(),
      status: 'PAUSED',
      logicalOwnerKey: `agent:${randomUUID()}`,
      baselineCheckpointRef: 'browser-checkpoint:empty:v1',
    },
  });
  const keyFor = (id: string) => `steel-browser-task-lifecycle:${id}`;
  keys.add(keyFor(row.id));
  const read = () => prisma.browserSession.findUniqueOrThrow({ where: { id: row.id } });
  const deps: ResumeLifecycleDependencies<string> = {
    readBinding: read,
    compatibility: 'default',
    reuseCompleted: true,
    sourceEnded: () => true,
    canFollow: async () => false,
    inspect: async (_provider, id) => (states.has(id) ? { id, status: states.get(id)! } : null),
    follow: async () => {
      throw new Error('unexpected follow');
    },
    resume: async () => {
      const result = await recreateSession(
        row.id,
        { forceManagedRotation: false, keepValidationConnection: true },
        {
          createSession: async (input) => {
            creates++;
            assert(input.sessionId);
            states.set(input.sessionId, 'active');
            return {
              id: input.sessionId,
              debugUrl: 'https://fixture.invalid',
              profileId: null,
            };
          },
          validateConnection: async () =>
            creates === 1
              ? 'fixture failed validation'
              : {
                  browser: { close: async () => {} } as Browser,
                  failure: null,
                },
          releaseSession: async (id) => {
            releases++;
            states.set(id, 'released');
          },
          inspectSession: async (id) => ({ id, status: states.get(id)! }),
        }
      );
      await browserResumeScope()!.beforeHydration(result.sessionId);
      return result.sessionId;
    },
  };
  try {
    const native = await withBrowserResumeLifecycle(row.id, deps);
    assert.equal(creates, 2);
    assert.equal(releases, 1);
    assert.equal((await read()).sessionId, native);
    const ledger = await prisma.toolSideEffect.findUniqueOrThrow({
      where: { operationKey: keyFor(row.id) },
    });
    assert.equal(ledger.status, 'RELEASED');
    assert.equal((ledger.response as { phase?: string }).phase, 'ready');

    // Re-enter an expired owner only with exact terminal proof and an unchanged source.
    const crashed = randomUUID(),
      candidate = randomUUID(),
      source = `source-${crashed}`;
    keys.add(keyFor(crashed));
    states.set(candidate, 'released');
    await prisma.toolSideEffect.create({
      data: {
        operationKey: keyFor(crashed),
        operationType: 'browser_task_resume',
        status: 'STARTED',
        externalId: randomUUID(),
        request: {
          source,
          provider: 'steel',
          requestId: candidate,
          ownershipIdentity: steelEnvironmentIdentity(),
          expiresAt: new Date(0).toISOString(),
          phase: 'creating',
          nativeOutstanding: true,
          compatibility: 'default',
        },
      },
    });
    let resumed = 0;
    await assert.rejects(
      withBrowserResumeLifecycle(crashed, {
        ...deps,
        readBinding: async () => ({ sessionId: source, status: 'PAUSED' }),
        resume: async () => {
          resumed++;
          throw new Error('fixture reclaimed settled attempt');
        },
      }),
      /fixture reclaimed settled attempt/
    );
    assert.equal(resumed, 1);
    assert.equal(
      (
        await prisma.toolSideEffect.findUniqueOrThrow({
          where: { operationKey: keyFor(crashed) },
        })
      ).status,
      'RELEASED'
    );

    for (const control of ['hydrating', 'unknown-native', 'foreign-owner', 'changed-source']) {
      const task = randomUUID(),
        native = randomUUID(),
        source = `source-${task}`;
      keys.add(keyFor(task));
      await prisma.toolSideEffect.create({
        data: {
          operationKey: keyFor(task),
          operationType: 'browser_task_resume',
          status: 'STARTED',
          externalId: randomUUID(),
          request: {
            source,
            provider: 'steel',
            requestId: native,
            ownershipIdentity:
              control === 'foreign-owner' ? 'another-owner' : steelEnvironmentIdentity(),
            expiresAt: new Date(0).toISOString(),
            phase: control === 'hydrating' ? 'hydrating' : 'creating',
            nativeOutstanding: true,
            compatibility: 'default',
          },
        },
      });
      let entered = 0;
      await assert.rejects(
        withBrowserResumeLifecycle(task, {
          ...deps,
          readBinding: async () => ({
            sessionId: control === 'changed-source' ? 'different' : source,
            status: 'PAUSED',
          }),
          inspect: async () =>
            control === 'unknown-native' ? null : { id: native, status: 'released' },
          resume: async () => {
            entered++;
            throw new Error('unsafe resume entered');
          },
        }),
        /unknown|ownership|source binding|ended candidate/
      );
      assert.equal(entered, 0, `${control} must not allocate`);
      assert.equal(
        (
          await prisma.toolSideEffect.findUniqueOrThrow({
            where: { operationKey: keyFor(task) },
          })
        ).status,
        'STARTED'
      );
    }
    console.log(
      'PASS settled Steel retry: real recreation, expired-owner recovery and four no-create controls'
    );
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: {
        OR: [
          { operationKey: { in: [...keys] } },
          { request: { path: ['taskId'], equals: row.id } },
        ],
      },
    });
    await prisma.browserContext.delete({ where: { id: context.id } });
    await prisma.user.delete({ where: { userId } });
  }
}

async function resumeWithFirstCreateFailure(firstFailure: Error): Promise<string> {
  const taskId = randomUUID();
  const nativeId = `native-${randomUUID()}`;
  let binding: { sessionId: string | null; status: string } = {
    sessionId: `old-${taskId}`,
    status: 'PAUSED',
  };
  const context = await prisma.browserContext.create({
    data: { userId: `resume-retry-${taskId}` },
  });
  await prisma.browserSession.create({
    data: {
      id: taskId,
      contextId: context.id,
      agentId: taskId,
      provider: 'kernel',
      sessionId: binding.sessionId,
      status: 'PAUSED',
    },
  });
  const attempt = async (create: () => Promise<string>) => {
    const scope = browserResumeScope()!;
    await scope.beforeCreate('kernel');
    return resumeNativeCreate(create);
  };
  try {
    return await withBrowserResumeLifecycle(taskId, {
      readBinding: async () => binding,
      resume: async () => {
        await attempt(() => Promise.reject(firstFailure)).catch(() => undefined);
        const created = await attempt(async () => nativeId);
        binding = { sessionId: created, status: 'ACTIVE' };
        await prisma.browserSession.update({
          where: { id: taskId },
          data: { sessionId: created, status: 'ACTIVE' },
        });
        await browserResumeScope()!.beforeHydration(created);
        return created;
      },
      follow: async () => {
        throw new Error('fixture never follows');
      },
      compatibility: 'default',
      canFollow: async () => false,
      reuseCompleted: true,
      sourceEnded: () => false,
      inspect: async () => null,
    });
  } finally {
    await prisma.toolSideEffect.deleteMany({
      where: { operationKey: `steel-browser-task-lifecycle:${taskId}` },
    });
    await prisma.browserContext.delete({ where: { id: context.id } });
  }
}

export async function runBrowserResumeRetryAfterRejectedCreateCase(): Promise<void> {
  const previousWorkspace = process.env.CONDUCTOR_WORKSPACE_NAME;
  process.env.CONDUCTOR_WORKSPACE_NAME = `resume-retry-${randomUUID()}`;
  try {
    const rejected = Object.assign(new Error('400 proxy not found'), {
      status: 400,
    });
    const created = await resumeWithFirstCreateFailure(rejected);
    assert.match(created, /^native-/, 'a definitely rejected create must permit the retry');

    await assert.rejects(
      resumeWithFirstCreateFailure(new Error('socket hang up')),
      /requires reconciliation before retry/,
      'an uncertain create must still block a second native create'
    );
    const taskId = randomUUID();
    const operationKey = `steel-browser-task-lifecycle:${taskId}`;
    const source = `old-${taskId}`;
    const candidate = randomUUID();
    await prisma.toolSideEffect.create({
      data: {
        operationKey,
        operationType: 'browser_task_resume',
        status: 'STARTED',
        externalId: randomUUID(),
        request: {
          source,
          provider: 'steel',
          requestId: candidate,
          ownershipIdentity: steelEnvironmentIdentity(),
          expiresAt: new Date(0).toISOString(),
          phase: 'creating',
          nativeOutstanding: true,
          compatibility: 'default',
        },
      },
    });
    try {
      await assert.rejects(
        withBrowserResumeLifecycle(taskId, {
          readBinding: async () => ({ sessionId: source, status: 'PAUSED' }),
          compatibility: 'default',
          reuseCompleted: true,
          sourceEnded: () => true,
          canFollow: async () => false,
          inspect: async () => ({ id: candidate, status: 'active' }),
          follow: async () => {
            throw new Error('must not follow');
          },
          resume: async () => {
            await browserResumeScope()!.beforeCreate('steel');
            return resumeNativeCreate(async () => {
              throw Object.assign(new Error('recovery GET failed'), {
                status: 404,
              });
            });
          },
        }),
        /recovery GET failed/
      );
      assert.equal(
        (
          await prisma.toolSideEffect.findUniqueOrThrow({
            where: { operationKey },
          })
        ).status,
        'STARTED',
        'a failed recovery GET is not a rejected native create'
      );
    } finally {
      await prisma.toolSideEffect.delete({ where: { operationKey } });
    }
    console.log('PASS resume retries a definitely rejected provider create within one resume');
  } finally {
    if (previousWorkspace === undefined) delete process.env.CONDUCTOR_WORKSPACE_NAME;
    else process.env.CONDUCTOR_WORKSPACE_NAME = previousWorkspace;
  }
}
