import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { retryWithBackoff } from '../../providers/retry';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import { fixture, withPhone } from './auth-assistance.native-fixtures';

type Test = [string, () => Promise<void>];
export const nativeBoundaryTests: Test[] = [
  [
    'completed native retry cannot touch a newer attention or successor lease',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const create = () =>
          h.request(f.userId, '/', { api: 'auth-assistance', method: 'POST', body: f.body });
        const first = await create();
        const id = (first.data.request as { id: string }).id;
        assert.equal(
          (await h.request(f.userId, `/${id}/complete`, { api: 'auth-assistance', method: 'POST' }))
            .status,
          200
        );
        const second = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: { ...f.body, requestKey: randomUUID() },
        });
        assert.equal(second.status, 201);
        const newerId = (second.data.request as { id: string }).id;
        const before = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } });
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        const signals = h.authSignals,
          resumes = h.authResumes;
        const retry = await h.request(f.userId, `/${id}/complete`, {
          api: 'auth-assistance',
          method: 'POST',
        });
        assert.equal(retry.status, 200, 'Completed retry rejected because newer attention exists');
        assert.equal(retry.data.alreadyCompleted, true);
        assert.equal(h.authSignals, signals);
        assert.equal(h.authResumes, resumes);
        assert.deepEqual(
          await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } }),
          before
        );
        assert.deepEqual(
          await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }),
          device
        );
        assert.equal(
          (await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id: newerId } }))
            .userResponse,
          null
        );
        await h.request(f.userId, `/leases/${f.leaseId}/release`, {
          actor: 'user',
          method: 'POST',
        });
        const agent = await h.createAgent(f.userId);
        const next = await h.acquire(f.userId, agent.id);
        const nextBefore = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: next.id } });
        const late = await h.request(f.userId, `/${id}/complete`, {
          api: 'auth-assistance',
          method: 'POST',
        });
        assert.equal(late.status, 200, 'Late completed receipt could not recover after release');
        assert.equal(h.authSignals, signals);
        assert.equal(h.authResumes, resumes);
        assert.deepEqual(
          await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: next.id } }),
          nextBefore
        );
      }),
  ],
  [
    'native pending attention retains FIFO deadlines and rejects changed context or foreign completion',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const other = await h.fixture();
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        const id = (created.data.request as { id: string }).id;
        const agent = await h.createAgent(f.userId);
        const waiting = await h.acquire(f.userId, agent.id);
        assert.equal(waiting.status, 'WAITING');
        const original = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: waiting.id } });
        await prisma.iPhoneLease.update({
          where: { id: f.leaseId },
          data: { leaseExpiresAt: new Date(0) },
        });
        assert.equal(
          (await h.request(f.userId, `/leases/${f.leaseId}`)).data.lease?.status,
          'ACTIVE'
        );
        assert.equal(
          (await h.request(f.userId, `/leases/${waiting.id}`)).data.lease?.status,
          'WAITING'
        );
        assert.equal(
          (
            await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: waiting.id } })
          ).queueDeadlineAt.getTime(),
          original.queueDeadlineAt.getTime()
        );
        assert.equal(
          (
            await h.request(f.userId, '/', {
              api: 'auth-assistance',
              method: 'POST',
              body: { ...f.body, criticalReason: 'verification_code' },
            })
          ).status,
          409
        );
        assert.equal(
          (
            await h.request(f.userId, '/', {
              api: 'auth-assistance',
              method: 'POST',
              body: { ...f.body, browserTaskId: randomUUID() },
            })
          ).status,
          409
        );
        assert.equal(
          (
            await h.request(other.userId, `/${id}/complete`, {
              api: 'auth-assistance',
              method: 'POST',
            })
          ).status,
          403
        );
        assert.equal(
          (await prisma.userAuthAssistanceRequest.findUniqueOrThrow({ where: { id } })).completedAt,
          null
        );
      }),
  ],
  [
    'native completion rejects cancelled task and obsolete workflow without authentication',
    () =>
      withPhone(async (h) => {
        for (const change of ['task', 'generation', 'rejected', 'terminal'] as const) {
          const f = await fixture(h);
          const created = await h.request(f.userId, '/', {
            api: 'auth-assistance',
            method: 'POST',
            body: f.body,
          });
          const id = (created.data.request as { id: string }).id;
          if (change === 'task') await prisma.browserSession.delete({ where: { id: f.taskId } });
          if (change === 'generation')
            await prisma.agent.update({
              where: { id: f.agentId },
              data: { temporalWorkflowId: `replacement-${randomUUID()}` },
            });
          if (change === 'rejected')
            await prisma.agentAttentionRequest.update({
              where: { id },
              data: { userResponse: '__REJECTED__' },
            });
          if (change === 'terminal')
            await prisma.agent.update({ where: { id: f.agentId }, data: { status: 'COMPLETED' } });
          const result = await h.request(f.userId, `/${id}/complete`, {
            api: 'auth-assistance',
            method: 'POST',
          });
          assert.ok([404, 409].includes(result.status), 'Stale native completion was accepted');
          assert.equal(
            (await prisma.userAuthAssistanceRequest.findUniqueOrThrow({ where: { id } }))
              .completedAt,
            null
          );
          assert.equal(await prisma.steelSessionAuth.count({ where: { userId: f.userId } }), 0);
          assert.equal(h.authSignals, 0);
        }
      }),
  ],
  [
    'native completion takes device before generation lock and rechecks generation after waiting',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        const id = (created.data.request as { id: string }).id;
        let entered!: () => void, release!: () => void;
        const locked = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const cleanup = runTransactionWithRetry(async (tx) => {
          await lockAgentWorkflowGeneration(tx, f.agentId);
          entered();
          await held;
          await tx.agent.update({
            where: { id: f.agentId },
            data: { temporalWorkflowId: `replacement-${randomUUID()}` },
          });
        });
        await locked;
        const completing = h.request(f.userId, `/${id}/complete`, {
          api: 'auth-assistance',
          method: 'POST',
        });
        try {
          await retryWithBackoff(
            async () => {
              let blocked = false;
              try {
                await runTransactionWithRetry(
                  (tx) =>
                    tx.$queryRaw`SELECT id FROM "IPhoneDevice" WHERE id=${f.deviceId} FOR UPDATE NOWAIT`
                );
              } catch (error) {
                blocked =
                  typeof error === 'object' &&
                  error !== null &&
                  'meta' in error &&
                  (error.meta as { code?: string })?.code === '55P03';
                if (!blocked) throw error;
              }
              assert.ok(blocked, 'Completion has not acquired device before generation lock');
            },
            {
              maxRetries: 10,
              fixedDelays: Array(10).fill(10),
              isRetryable: () => true,
              component: 'NativeCompletionLockObservation',
            }
          );
        } finally {
          release();
        }
        await cleanup;
        assert.equal((await completing).status, 409);
        assert.equal(h.authSignals, 0);
      }),
  ],
  [
    'native protocol conflict maps through generic attention respond without exposing input',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        const id = (created.data.request as { id: string }).id;
        h.inputMode = 'unknown';
        await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          actor: 'user',
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'input.text',
            args: { s: 'synthetic protected input' },
            attentionRequestId: id,
          },
        });
        const response = await fetch(
          `${process.env.TEST_BASE_URL}/api/attention-requests/${id}/respond`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': process.env.BACKEND_API_KEY ?? '',
              'X-User-Id': f.userId,
            },
            body: JSON.stringify({ response: '__AUTH_ASSISTANCE_COMPLETED__' }),
          }
        );
        assert.equal(response.status, 409, 'Native protocol conflict mapped to server error');
        assert.equal(
          (await prisma.userAuthAssistanceRequest.findUniqueOrThrow({ where: { id } })).completedAt,
          null
        );
      }),
  ],
  [
    'native completion cannot cross an owner PNG RPC in flight',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        const id = (created.data.request as { id: string }).id;
        const held = h.holdFrame();
        const frame = h.request(f.userId, `/leases/${f.leaseId}/frame`, { actor: 'user' });
        await held.entered;
        try {
          const completing = await h.request(f.userId, `/${id}/complete`, {
            api: 'auth-assistance',
            method: 'POST',
          });
          assert.equal(completing.status, 409);
          assert.equal(h.authSignals, 0);
        } finally {
          held.release();
          assert.equal((await frame).status, 200);
        }
        assert.equal(
          (await h.request(f.userId, `/${id}/complete`, { api: 'auth-assistance', method: 'POST' }))
            .status,
          200
        );
      }),
  ],
  [
    'native operation UUID cannot cross attention binding and user bounds uses same fence',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const first = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        const id = (first.data.request as { id: string }).id;
        const operationId = randomUUID();
        const command = (attentionRequestId: string) =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            actor: 'user',
            method: 'POST',
            body: {
              operationId,
              operation: 'screen.bounds',
              args: {},
              attentionRequestId,
              expectedCursor: 0,
            },
          });
        const bounds = await command(id);
        assert.equal(bounds.status, 200);
        assert.deepEqual(bounds.data.operation?.result, h.screenBounds);
        assert.equal(
          (await h.request(f.userId, `/${id}/complete`, { api: 'auth-assistance', method: 'POST' }))
            .status,
          200
        );
        const next = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: { ...f.body, requestKey: randomUUID(), expectedCursor: 1 },
        });
        const nextId = (next.data.request as { id: string }).id;
        assert.equal(next.status, 201);
        const calls = h.calls.length;
        assert.equal(
          (await command(nextId)).status,
          409,
          'Stable operation accepted changed attention binding'
        );
        assert.equal(h.calls.length, calls);
        assert.equal(
          (await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } })).actionCursor,
          1
        );
      }),
  ],
];
