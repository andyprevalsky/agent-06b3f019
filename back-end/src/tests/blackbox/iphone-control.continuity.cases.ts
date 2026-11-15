import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  setupState,
  configurationState,
  sealSetup,
  type SetupState,
} from '../../providers/phoneSetupState';
import { fixture } from './auth-assistance.native-fixtures';
import { phoneFixtureNumber } from './phone-fixture-users';
import type { Harness } from './iphone-control.fixtures';
import type { Case } from './iphone-control.cases';
import { useSavedPaymentFixture, encryptSavedFixture } from './iphone-control.saved-key-fixture';
import { cleanupTerminalAgentWorkflowZombies } from '../../providers/workflowTerminalCleanup';
import {
  authorizeSyntheticSetup,
  freshSetup,
  observe,
  proveSettings,
} from './iphone-control.setup-fixtures';
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { PhoneHarnessSession } from '../../providers/phoneHarness';
import { claimCommand, beginExecution } from '../../domains/iphone/repo.operations';

async function borrow(h: Harness, normalConnection = false) {
  const f = await fixture(h);
  if (normalConnection) await authorizeSyntheticSetup(f);
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

type Borrowed = Awaited<ReturnType<typeof borrow>>;

async function retireProducer(f: Borrowed, original: SetupState) {
  await prisma.agent.update({ where: { id: f.producerId }, data: { status: 'COMPLETED' } });
  const terminated: string[] = [];
  const cleanup = await cleanupTerminalAgentWorkflowZombies(
    {
      captureInProgressTools: async () => [],
      resolveExecution: async (workflowId) => ({
        workflowId,
        firstExecutionRunId: original.attempt!.firstExecutionRunId!,
      }),
      terminate: async (execution) => {
        terminated.push(execution.workflowId);
      },
      finalizeInterruptedTools: async () => undefined,
    },
    { agentIds: [f.producerId], ignoreGrace: true }
  );
  assert.equal(
    cleanup.sealed,
    1,
    'The real terminal cleanup path must seal the completed producer'
  );
  assert.equal(terminated.length, 1);
  const retired = await prisma.agent.findUniqueOrThrow({ where: { id: f.producerId } });
  assert.equal(retired.temporalFirstExecutionRunId, null);
  assert.notEqual(retired.temporalWorkflowId, original.attempt!.workflowId);
}

async function assertArchivedConnection(h: Harness, f: Borrowed) {
  await prisma.agent.update({ where: { id: f.producerId }, data: { deletedAt: new Date() } });
  const archived = await h.request(f.userId, '/connection', { actor: 'user' });
  assert.equal(archived.status, 200);
  assert.equal(
    archived.data.status,
    'ready',
    'Archived setup producer invalidated committed phone facts'
  );
  let launches = 0;
  h.setupAgentLauncher = async () => {
    launches++;
    throw new Error('Ready connection must not launch setup');
  };
  const connect = await h.request(f.userId, '/connect', {
    actor: 'user',
    method: 'POST',
    body: { requestKey: randomUUID(), expectedRevision: archived.data.connectionRevision },
  });
  assert.equal(connect.status, 200);
  assert.equal(connect.data.status, 'ready');
  assert.equal(launches, 0);
}

type ChecksView = Record<string, { current: boolean; status: string }>;
async function setupChecks(h: Harness, f: { userId: string; taskId: string }) {
  const view = await h.request(f.userId, `/interactions/${f.taskId}`);
  assert.equal(view.status, 200);
  return (view.data.setup as { verification: { checks: ChecksView } }).verification.checks;
}

export const continuityCases: Case[] = [
  // Prod 2026-11-14 lease c5b5d796: the 30-minute harness session expired mid first setup
  // (cursor 167 failed phone_connection_not_ready; epoch 14 -> 15 on the reconciler's confirmed
  // cleanup) and every verified step went current:false. Both stop paths reach confirmCleanup.
  ...(['in-op', 'reconciler'] as const).map((path): Case => [
    `session expiry refresh (${path}) during an in-progress first setup keeps verified steps without promoting`,
    async (h) => {
      const f = await freshSetup(h);
      const proven = ['icloud_messages', 'icloud_keychain', 'icloud_contacts', 'imessage'];
      await proveSettings(h, f, false, false, true, false, false);
      const before = await setupChecks(h, f);
      for (const target of proven) assert.equal(before[target]?.current, true, target);
      assert.equal(before.apple_account?.current, false);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const saved = openPhoneValue<PhoneHarnessSession>(device.providerSessionEncrypted!);
      // Inside isFresh's 10 s margin, exactly as the prod session at 18:37:37.
      saved.expiresAt = Math.floor(Date.now() / 1000) + 5;
      saved.control!.expiresAt = saved.expiresAt;
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { providerSessionEncrypted: sealPhoneValue(saved) },
      });
      const start = h.calls.length;
      if (path === 'in-op') {
        h.beforeStop = async (sessionId) => {
          h.endedSessions.add(sessionId);
        };
        await observe(h, f);
      } else {
        // Prod order: the stop is not yet confirmed, so the agent read fails not-ready...
        const pending = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'screen.text',
            args: {},
            setupAttemptId: f.setup.attemptId,
            setupRevision: f.setup.revision,
          },
        });
        assert.notEqual(pending.data.operation?.status, 'SUCCEEDED');
        // ...then the harness confirms cleanup and the next interaction read reconciles it.
        h.endedSessions.add(saved.id);
        await setupChecks(h, f);
        await observe(h, f);
      }
      assert.ok(
        h.calls.slice(start).some((c) => c.method === 'DELETE'),
        'Expiring session was not refreshed'
      );
      const refreshed = await prisma.iPhoneDevice.findUniqueOrThrow({
        where: { id: f.deviceId },
      });
      assert.equal(refreshed.providerEpoch, device.providerEpoch + 1);
      const after = await setupChecks(h, f);
      for (const target of proven) {
        assert.equal(after[target]?.current, true, `Session refresh discarded verified ${target}`);
        assert.equal(after[target]?.status, 'confirmed', target);
      }
      // Negative controls: no unobserved step, runtime proof or readiness is promoted.
      assert.equal(after.apple_account?.current, false);
      assert.equal(after.runtime?.current, false);
      const proof = setupState(refreshed.setupEncrypted).verification!.checks.imessage!;
      assert.equal(proof.observedProviderEpoch, device.providerEpoch);
      assert.equal(
        proof.observedAt,
        setupState(device.setupEncrypted).verification!.checks.imessage!.observedAt
      );
      const connection = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.notEqual(connection.data.status, 'ready');
    },
  ]),
  [
    'an admitted context-free command cannot follow its borrower into a new first run',
    async (h) => {
      const f = await borrow(h);
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
          })
        ).data.operation?.status,
        'SUCCEEDED'
      );
      const claim = await claimCommand(
        f.userId,
        f.leaseId,
        {
          operationId: randomUUID(),
          operation: 'screen.text',
          args: {},
        },
        'agent',
        false,
        true
      );
      assert.equal(claim.execute, true);
      assert.equal(claim.command.state, 'CONNECTING');
      const firstRun = randomUUID();
      await prisma.agent.update({
        where: { id: f.agentId },
        data: { temporalFirstExecutionRunId: firstRun },
      });
      // Ordinary frontend polling may establish legitimate new-run custody.
      const view = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal(view.status, 200);
      assert.equal((view.data.setup as { required: boolean }).required, false);
      const state = setupState(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted
      );
      assert.equal(state.attempt?.firstExecutionRunId, firstRun);
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, true);
      const calls = h.physicalOperations.length;
      assert.equal(
        await beginExecution(claim),
        false,
        'Old admission followed the refreshed borrower into its new execution chain'
      );
      assert.equal(
        (await prisma.iPhoneOperation.findUniqueOrThrow({ where: { id: claim.command.id } })).state,
        'FAILED'
      );
      assert.equal(
        h.physicalOperations.length,
        calls,
        'Owning admission test must not execute a physical command'
      );
      const fresh = await claimCommand(
        f.userId,
        f.leaseId,
        {
          operationId: randomUUID(),
          operation: 'screen.text',
          args: {},
        },
        'agent',
        false,
        true
      );
      assert.equal(fresh.execute, true);
      assert.equal(
        await beginExecution(fresh),
        true,
        'New chain must receive its own legitimate admission'
      );
    },
  ],
  [
    'legacy ready configuration without producer identity is unavailable before borrowing',
    async (h) => {
      const f = await fixture(h);
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'ready'
      );
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const legacy = setupState(device.setupEncrypted);
      assert.equal(legacy.completedConfiguration, undefined);
      delete (legacy.attempt as { agentId?: string }).agentId;
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupEncrypted: sealSetup(legacy) },
      });
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'not_connected'
      );
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, false);
    },
  ],
  [
    'completed phone configuration survives normal producer workflow retirement',
    async (h) => {
      const f = await borrow(h, true);
      const original = configurationState(
        setupState(
          (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
            .setupEncrypted
        )
      );
      await retireProducer(f, original);
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'ready'
      );
      await assertArchivedConnection(h, f);
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, true);
      assert.equal(
        (
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
          })
        ).data.operation?.status,
        'SUCCEEDED'
      );
      const after = configurationState(
        setupState(
          (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
            .setupEncrypted
        )
      );
      assert.deepEqual(
        after.attempt,
        original.attempt,
        'Retirement rewrote immutable setup provenance'
      );
      assert.deepEqual(after.verified, original.verified);
      h.cleanupComplete = true;
      assert.equal(
        (await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
        200
      );
      h.cleanupComplete = false;
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'ready',
        'Normal stop after producer retirement discarded completed configuration'
      );
    },
  ],
  [
    'borrowed saved-credential execution rejects current borrower revocation after its verifier',
    async (h) => {
      const f = await borrow(h);
      const payment = useSavedPaymentFixture();
      const secret = `synthetic-borrower-revocation-${randomUUID()}`;
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
            where: { id: f.agentId },
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
  ...(['consumer', 'phone', 'profile'] as const).map((change): Case => [
    `completed setup reuse retains ${change} revocation fences`,
    async (h) => {
      const f = await borrow(h);
      assert.equal((await h.request(f.userId, `/availability/${f.taskId}`)).data.enabled, true);
      if (change === 'phone')
        await prisma.user.update({
          where: { userId: f.userId },
          data: { phone: phoneFixtureNumber() },
        });
      else if (change === 'profile') {
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        const state = setupState(device.setupEncrypted);
        state.profileRevision++;
        await prisma.iPhoneDevice.update({
          where: { id: f.deviceId },
          data: { setupEncrypted: sealSetup(state) },
        });
      } else
        await prisma.agent.update({
          where: { id: f.agentId },
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
