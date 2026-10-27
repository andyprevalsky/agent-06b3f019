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
    const rejected = Object.assign(new Error('400 proxy not found'), { status: 400 });
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
              throw Object.assign(new Error('recovery GET failed'), { status: 404 });
            });
          },
        }),
        /recovery GET failed/
      );
      assert.equal(
        (await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey } })).status,
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
