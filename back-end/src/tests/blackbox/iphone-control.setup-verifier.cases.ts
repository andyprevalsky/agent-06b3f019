import assert from 'node:assert/strict';
import { settingsCases } from './iphone-control.settings.cases';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { sealPhoneValue, openPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { Case } from './iphone-control.cases';
import {
  freshSetup,
  proveSettings,
  observe,
  setupPost,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
import { setupRaceCases } from './iphone-control.setup-races.cases';
export const setupVerifierCases: Case[] = [
  ...setupRaceCases,
  ...settingsCases,
  [
    'signed-in Apple identity with disabled Messages settings must not yield overall setup ready',
    async (h) => {
      const f = await freshSetup(h);
      h.observationResult = {
        text: `Apple Account: ${f.identity}. Signed in. iCloud Messages: Off. iMessage: signed out.`,
      };
      const observation = await observe(h, f);
      let calls = 0;
      h.setupVerifier = async (input) => {
        calls++;
        assert.equal(input.expectedAppleIdentity, f.identity);
        assert.equal(input.evidence[0].operationId, observation.id);
        assert.deepEqual(input.evidence[0].result, h.observationResult);
        // The existing verifier proves identity only, not Messages configuration.
        return { identityConfirmed: true, usage: verifierUsage };
      };
      const response = await setupPost(h, f, {
        action: 'verify',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: observation.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [observation.id],
      });
      assert.equal(response.status, 200);
      assert.equal(calls, 1);
      assert.notEqual(
        (response.data.setup as SetupDto).state,
        'ready',
        'Identity-only proof incorrectly marked disabled/signed-out Messages configuration ready'
      );
      const durable = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.notEqual(durable.setupState, 'ready');
    },
  ],
  [
    'setup verifier consumes actual sanitized receipts once and ready never replays original intent',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f, false);
      const original = randomUUID();
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: original, operation: 'input.tap', args: { x: 1, y: 2 } },
        });
      assert.equal((await send()).data.operation?.errorCode, 'phone_setup_required');
      const secret = `private-${randomUUID()}`;
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: {
          privateInputEncrypted: sealPhoneValue({ version: 1, active: false, values: [secret] }),
        },
      });
      h.observationResult = {
        text: `Apple account ${f.identity} ${secret}`,
        png_b64: Buffer.from(secret).toString('base64'),
      };
      const observation = await observe(h, f);
      let calls = 0;
      h.setupVerifier = async (input) => {
        calls++;
        assert.equal(input.expectedAppleIdentity, f.identity);
        assert.equal(input.evidence[0].operationId, observation.id);
        assert.ok(!JSON.stringify(input).includes(secret));
        assert.ok(!JSON.stringify(input).includes(Buffer.from(secret).toString('base64')));
        return { identityConfirmed: true, usage: verifierUsage };
      };
      const body = {
        action: 'verify',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: observation.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [observation.id],
      };
      const response = await setupPost(h, f, body);
      assert.equal(response.status, 200);
      assert.equal(response.data.operation?.status, 'SUCCEEDED');
      assert.equal((response.data.setup as SetupDto).state, 'ready');
      assert.equal((response.data.usage as { billedBy: string }).billedBy, 'backend');
      const repeat = await setupPost(h, f, body);
      assert.equal(repeat.data.operation?.id, body.requestKey);
      assert.equal(calls, 1);
      assert.equal(
        await prisma.toolUsage.count({
          where: { agentId: f.agentId, toolName: 'phone_setup_identity' },
        }),
        1
      );
      const status = await h.request(f.userId, `/interactions/${f.taskId}`);
      assert.equal((status.data.setup as SetupDto).lastRequest?.requestKey, body.requestKey);
      const before = h.physicalOperations.length;
      assert.equal((await send()).data.operation?.status, 'FAILED');
      assert.equal(h.physicalOperations.length, before);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(!JSON.stringify(device).includes(f.identity));
      assert.ok(openPhoneValue<{ verified: unknown }>(device.setupEncrypted!).verified);
    },
  ],
  [
    'setup current task deferral keeps diagnostics supported and next task must reassess',
    async (h) => {
      const f = await freshSetup(h);
      const body = {
        action: 'defer',
        reasonCode: 'user_constraint',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: 0,
        requestKey: randomUUID(),
      };
      const deferred = await setupPost(h, f, body);
      assert.equal(deferred.status, 200);
      const setup = deferred.data.setup as SetupDto;
      assert.equal(setup.state, 'deferred');
      assert.equal(setup.required, true);
      assert.equal((await setupPost(h, f, body)).data.operation?.id, body.requestKey);
      const diagnostics = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'apps.list',
          args: {},
          setupAttemptId: setup.attemptId,
          setupRevision: setup.revision,
        },
      });
      assert.equal(diagnostics.data.operation?.status, 'SUCCEEDED');
      h.cleanupComplete = true;
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      h.cleanupComplete = false;
      const agent = await h.createAgent(f.userId);
      const lease = await h.acquire(f.userId, agent.id);
      const context = await prisma.browserContext.findUniqueOrThrow({
        where: { userId: f.userId },
      });
      const task = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: agent.id, sessionId: randomUUID() },
      });
      await prisma.iPhoneLease.update({
        where: { id: lease.id },
        data: { browserTaskId: task.id },
      });
      const next = (await h.request(f.userId, `/interactions/${task.id}`)).data.setup as SetupDto;
      assert.equal(next.state, 'in_progress');
      assert.notEqual(next.attemptId, setup.attemptId);
      assert.equal(next.required, true);
      assert.equal((await setupPost(h, f, body)).status, 409);
    },
  ],
  [
    'setup verify rejects forged, stale, foreign and private evidence before model invocation',
    async (h) => {
      const f = await freshSetup(h);
      const other = await freshSetup(h);
      let calls = 0;
      h.setupVerifier = async () => {
        calls++;
        return { identityConfirmed: true, usage: verifierUsage };
      };
      const foreign = await observe(h, other);
      const own = await observe(h, f);
      const base = {
        action: 'verify',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: own.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [own.id],
      };
      for (const body of [
        { ...base, passed: true },
        { ...base, evidenceOperationIds: [foreign.id] },
        { ...base, expectedCursor: 0 },
        { ...base, attemptId: other.setup.attemptId },
      ])
        assert.ok([400, 409].includes((await setupPost(h, f, body)).status));
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values: [] }) },
      });
      assert.equal((await setupPost(h, f, base)).status, 409);
      assert.equal(calls, 0);
    },
  ],
  [
    'setup verify pending retry never duplicates model call and profile change fences late ready',
    async (h) => {
      const f = await freshSetup(h);
      const observation = await observe(h, f);
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      let calls = 0;
      h.setupVerifier = async () => {
        calls++;
        enter();
        await held;
        return { identityConfirmed: true, usage: verifierUsage };
      };
      const body = {
        action: 'verify',
        attemptId: f.setup.attemptId,
        expectedRevision: f.setup.revision,
        expectedCursor: observation.cursor,
        requestKey: randomUUID(),
        evidenceOperationIds: [observation.id],
      };
      const first = setupPost(h, f, body);
      await entered;
      try {
        const duplicate = await setupPost(h, f, body);
        assert.equal(duplicate.data.operation?.status, 'RUNNING');
        assert.equal(calls, 1);
        assert.equal(
          (await h.request(f.userId, `/leases/${f.leaseId}/frame`, { actor: 'user' })).status,
          409
        );
        const changed = await h.request(f.userId, '/device/setup-profile', {
          method: 'PUT',
          body: {
            expectedProfileRevision: 1,
            expectedAppleIdentity: 'changed-synthetic@example.invalid',
          },
        });
        assert.equal(changed.status, 200);
      } finally {
        release();
      }
      const result = await first;
      assert.equal(result.data.operation?.status, 'FAILED');
      assert.notEqual((result.data.setup as SetupDto).state, 'ready');
      assert.equal(calls, 1);
      assert.equal(
        await prisma.toolUsage.count({
          where: { agentId: f.agentId, toolName: 'phone_setup_identity' },
        }),
        1
      );
    },
  ],
  [
    'setup profile refuses unconfirmed UNKNOWN without slot and fresh generation gets new claim',
    async (h) => {
      const f = await freshSetup(h);
      await prisma.iPhoneOperation.create({
        data: {
          deviceId: f.deviceId,
          leaseId: f.leaseId,
          requestKey: randomUUID(),
          operation: 'input.tap',
          actor: 'agent',
          cursor: 0,
          inputHash: 'synthetic',
          requestEncrypted: sealPhoneValue({}),
          state: 'UNKNOWN',
          activeDeviceId: null,
          providerEpoch: 0,
          deadlineAt: new Date(),
          errorCode: 'provider_error',
        },
      });
      const denied = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: { expectedProfileRevision: 1, expectedAppleIdentity: 'replacement@example.invalid' },
      });
      assert.equal(denied.status, 409, 'Profile changed while physical outcome remained unknown');
      await prisma.iPhoneOperation.deleteMany({ where: { leaseId: f.leaseId, state: 'UNKNOWN' } });
      await prisma.agent.update({
        where: { id: f.agentId },
        data: { temporalWorkflowId: `replacement-${randomUUID()}` },
      });
      const next = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      assert.notEqual(
        next.attemptId,
        f.setup.attemptId,
        'Fresh generation retained obsolete setup claim'
      );
      assert.ok(next.revision > f.setup.revision);
    },
  ],
  [
    'fresh workflow generation on the same active lease gets a new setup claim',
    async (h) => {
      const f = await freshSetup(h);
      await prisma.agent.update({
        where: { id: f.agentId },
        data: { temporalWorkflowId: `replacement-${randomUUID()}` },
      });
      const next = (await h.request(f.userId, `/interactions/${f.taskId}`)).data.setup as SetupDto;
      assert.notEqual(
        next.attemptId,
        f.setup.attemptId,
        'Fresh generation retained obsolete setup claim'
      );
      assert.ok(next.revision > f.setup.revision);
    },
  ],
];
