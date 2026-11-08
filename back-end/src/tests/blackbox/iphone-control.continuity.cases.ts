import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { setupState, configurationState } from '../../providers/phoneSetupState';
import { fixture } from './auth-assistance.native-fixtures';
import { phoneFixtureNumber } from './phone-fixture-users';
import type { Harness } from './iphone-control.fixtures';
import type { Case } from './iphone-control.cases';
import { configurationGenerationCurrent } from '../../domains/iphone/repo.availability';
import { useSavedPaymentFixture, encryptSavedFixture } from './iphone-control.saved-key-fixture';
import { retryWithBackoff } from '../../providers/retry';

async function borrow(h: Harness) {
  const f = await fixture(h);
  const before = setupState(
    (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted
  );
  assert.equal(
    (
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
      })
    ).data.operation?.status,
    'SUCCEEDED'
  );
  h.cleanupComplete = true;
  assert.equal(
    (await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
    200
  );
  h.cleanupComplete = false;
  const consumer = await h.createAgent(f.userId);
  const context = await prisma.browserContext.findUniqueOrThrow({ where: { userId: f.userId } });
  const task = await prisma.browserSession.create({
    data: { agentId: consumer.id, contextId: context.id, sessionId: randomUUID() },
  });
  const ensured = await h.request(f.userId, `/interactions/${task.id}`, {
    method: 'POST',
    body: { requestKey: randomUUID() },
  });
  assert.equal(ensured.status, 200);
  const leaseId = (ensured.data.lease as { id: string }).id;
  const next = setupState(
    (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted
  );
  assert.equal(next.attempt?.agentId, consumer.id, 'Borrowing lost its own execution custody');
  const completed = configurationState(next);
  assert.equal(completed.attempt?.agentId, f.agentId, 'Borrowing rewrote setup provenance');
  assert.equal(
    completed.verification?.checks.apple_account?.observedAt,
    before.verification?.checks.apple_account?.observedAt
  );
  assert.equal(
    completed.verification?.checks.apple_account?.evidenceDigest,
    before.verification?.checks.apple_account?.evidenceDigest
  );
  assert.equal(completed.verification?.checks.runtime, undefined);
  return { ...f, producerId: f.agentId, agentId: consumer.id, taskId: task.id, leaseId };
}

export const continuityCases: Case[] = [
  [
    'configuration producer revocation waits for the admitting transaction to commit',
    async (h) => {
      const f = await borrow(h);
      const state = setupState(
        (
          await prisma.iPhoneDevice.findUniqueOrThrow({
            where: { id: f.deviceId },
          })
        ).setupEncrypted
      );
      let release!: () => void, admitted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      let holderPid = 0,
        writerPid = 0,
        written = false;
      const admission = prisma.$transaction(async (tx) => {
        holderPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
        assert.equal(await configurationGenerationCurrent(tx, f.userId, state), true);
        admitted();
        await gate;
      });
      let writer: Promise<unknown> | undefined;
      try {
        await entered;
        writer = prisma.$transaction(async (tx) => {
          writerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
            .pid;
          await tx.agent.update({
            where: { id: f.producerId },
            data: {
              temporalFirstExecutionRunId: randomUUID(),
            },
          });
          written = true;
        });
        const deadline = Date.now() + 2000;
        const blocked = await retryWithBackoff(
          async () => {
            if (!writerPid || Date.now() >= deadline) return false;
            return (
              await prisma.$queryRaw<{ blocked: boolean }[]>`
            SELECT ${holderPid}::integer = ANY(pg_blocking_pids(${writerPid}::integer)) AS blocked
          `
            )[0].blocked;
          },
          {
            maxRetries: 200,
            fixedDelays: Array.from({ length: 200 }, () => 10),
            shouldRetryResult: (blocked) => !blocked && !written && Date.now() < deadline,
            isRetryable: () => false,
            component: 'PhoneProducerAdmissionTest',
          }
        );
        assert.equal(blocked, true, 'Producer revocation was not serialized with admission');
        assert.equal(written, false);
      } finally {
        release();
        await admission;
        await writer;
      }
      assert.equal(written, true);
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, false);
    },
  ],
  [
    'borrowed saved-credential execution rejects producer revocation after its verifier',
    async (h) => {
      const f = await borrow(h);
      const payment = useSavedPaymentFixture();
      const secret = `synthetic-producer-revocation-${randomUUID()}`;
      const state = setupState(
        (
          await prisma.iPhoneDevice.findUniqueOrThrow({
            where: { id: f.deviceId },
          })
        ).setupEncrypted
      );
      const password = await prisma.browserPassword.create({
        data: {
          userId: f.userId,
          origin: 'https://appleid.apple.com',
          username: state.expectedAppleIdentity!,
          encryptedPassword: encryptSavedFixture(secret),
          browserSource: 'fixture',
          dateLastUsed: BigInt(Date.now()),
        },
      });
      try {
        const read = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
        });
        assert.equal(read.data.operation?.status, 'SUCCEEDED');
        let verifies = 0;
        h.credentialVerifier = async () => {
          verifies++;
          return { allowed: true, x: 50, y: 70, credentialRealm: 'apple' };
        };
        h.beforeSavedExecute = async () => {
          await prisma.agent.update({
            where: { id: f.producerId },
            data: {
              temporalFirstExecutionRunId: randomUUID(),
            },
          });
        };
        const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'credentials.fill_saved',
            args: {},
            expectedCursor: (read.data.operation as unknown as { cursor: number }).cursor,
          },
        });
        assert.equal(
          response.status,
          200,
          'Credential race must reach the normal operation handler'
        );
        assert.equal(verifies, 1);
        assert.equal(response.data.operation?.status, 'FAILED');
        assert.equal(h.physicalOperations.filter((op) => op.op.startsWith('input.')).length, 0);
        assert.equal(JSON.stringify(response.data).includes(secret), false);
      } finally {
        payment();
        await prisma.browserPassword.delete({ where: { id: password.id } });
      }
    },
  ],
  ...(['producer', 'consumer', 'phone'] as const).map((change): Case => [
    `completed setup reuse retains ${change} revocation fences`,
    async (h) => {
      const f = await borrow(h);
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, true);
      if (change === 'phone')
        await prisma.user.update({
          where: { userId: f.userId },
          data: { phone: phoneFixtureNumber() },
        });
      else
        await prisma.agent.update({
          where: { id: change === 'producer' ? f.producerId : f.agentId },
          data: { temporalFirstExecutionRunId: randomUUID() },
        });
      const before = h.calls.length;
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, false);
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
          })
        ).status,
        409
      );
      assert.equal(h.calls.length, before, 'Revoked borrowed configuration reached the provider');
    },
  ]),
  [
    'borrowed phone handback invalidates cached settings while current custody can reverify',
    async (h) => {
      const f = await borrow(h);
      for (const mode of ['user', 'agent'])
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/control`, {
              actor: 'user',
              method: 'POST',
              body: { mode },
            })
          ).status,
          200
        );
      const view = await h.request(f.userId, `/interactions/${f.taskId}`);
      const setup = view.data.setup as { required: boolean; attemptId: string; revision: number };
      assert.equal(setup.required, true);
      const state = setupState(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted
      );
      assert.equal(
        state.completedConfiguration,
        undefined,
        'Handback kept old native setting evidence'
      );
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, true);
      const blocked = await h.request(f.userId, `/interactions/${f.taskId}/setup`, {
        method: 'POST',
        body: {
          action: 'block',
          reasonCode: 'observed_signed_out',
          attemptId: setup.attemptId,
          expectedRevision: setup.revision,
          expectedCursor: view.data.cursor,
          requestKey: randomUUID(),
        },
      });
      assert.equal(blocked.status, 200);
      assert.equal(blocked.data.operation?.status, 'SUCCEEDED');
      assert.equal(
        (await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled,
        false,
        'Observed sign-out retained borrowed authority'
      );
    },
  ],
];
