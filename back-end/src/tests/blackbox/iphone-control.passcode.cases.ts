import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { setupState } from '../../providers/phoneSetupState';
import { privacyState } from '../../providers/phoneInputPrivacy';
import {
  freshSetup,
  authorizeSyntheticSetup,
  observe,
  proveSettings,
  setupPost,
  verifierUsage,
  type SetupDto,
} from './iphone-control.setup-fixtures';
import type { Case } from './iphone-control.cases';
export const passcodeCases: Case[] = [
  [
    'default passcode creation and confirmation are private stable intents, never existing-code guesses',
    async (h) => {
      const f = await freshSetup(h);
      let stage: 'create' | 'acknowledge' | 'confirm' = 'create';
      h.credentialVerifier = async () => ({ allowed: true, passcodeStage: stage, x: 50, y: 70 });
      let lastBody: Record<string, unknown> = {};
      const fill = async (id = randomUUID()) => {
        const read = await observe(h, f);
        lastBody = {
          operationId: id,
          operation: 'credentials.fill_device_passcode',
          args: {},
          expectedCursor: read.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        };
        return h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: lastBody,
        });
      };
      stage = 'confirm';
      assert.equal(
        (await fill()).data.operation?.status,
        'FAILED',
        'Confirmation cannot precede owned creation'
      );
      stage = 'create';
      const created = await fill();
      assert.equal(created.data.operation?.status, 'SUCCEEDED');
      assert.ok(!JSON.stringify(created.data).includes('1234'));
      const inputsBeforeReplay = h.physicalOperations.length;
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: lastBody,
      });
      assert.equal(h.physicalOperations.length, inputsBeforeReplay);
      const status = await h.request(
        f.userId,
        `/leases/${f.leaseId}/operations/${created.data.operation!.id}`
      );
      assert.deepEqual(status.data.operation, created.data.operation);
      stage = 'acknowledge';
      const inputsBeforeAck = h.physicalOperations.filter((op) => op.op === 'input.text').length;
      const tapsBeforeAck = h.physicalOperations.filter((op) => op.op === 'input.tap').length;
      const acknowledged = await fill();
      assert.equal(acknowledged.data.operation?.status, 'SUCCEEDED');
      assert.deepEqual(acknowledged.data.operation?.result, {
        success: true,
        private: true,
        passcodeStatus: 'acknowledged',
      });
      assert.equal(
        h.physicalOperations.filter((op) => op.op === 'input.text').length,
        inputsBeforeAck
      );
      assert.equal(
        h.physicalOperations.filter((op) => op.op === 'input.tap').length,
        tapsBeforeAck + 1
      );
      const ackCount = h.physicalOperations.length;
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: lastBody,
      });
      assert.equal(h.physicalOperations.length, ackCount);
      stage = 'confirm';
      const confirmed = await fill();
      assert.equal(confirmed.data.operation?.status, 'SUCCEEDED');
      assert.ok(!JSON.stringify(confirmed.data).includes('1234'));
      assert.equal(
        h.physicalOperations.filter((op) => op.op === 'input.text' && op.kw.s === '1234').length,
        2,
        'Requested backend default changed or was not used for create and confirm'
      );
      const confirmedCount = h.physicalOperations.length;
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: lastBody,
      });
      assert.equal(h.physicalOperations.length, confirmedCount);
      h.credentialVerifier = async () => ({ allowed: false });
      assert.equal((await fill()).data.operation?.status, 'FAILED');
    },
  ],

  [
    'passcode boot proof rejects MDM restriction and requires explicit enabled evidence',
    async (h) => {
      const f = await freshSetup(h);
      await proveSettings(h, f, true, true, true, true, false);
      assert.notEqual(f.setup.state, 'ready');
      h.observationResult = { text: 'MDM Restrictions: Passcode modification not allowed' };
      h.credentialVerifier = async () => ({ allowed: false });
      const read = await observe(h, f);
      const before = h.physicalOperations.filter((op) => op.op === 'input.text').length;
      const denied = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'credentials.fill_device_passcode',
          args: {},
          expectedCursor: read.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      assert.equal(denied.data.operation?.status, 'FAILED');
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, before);
      for (const status of ['unknown', 'confirmed', 'disabled'] as const) {
        h.setupVerifier = async () => ({ identityConfirmed: false, status, usage: verifierUsage });
        const evidence = await observe(h, f);
        const reply = await setupPost(h, f, {
          action: 'verify',
          verificationTarget: 'device_passcode',
          attemptId: f.setup.attemptId,
          expectedRevision: f.setup.revision,
          expectedCursor: evidence.cursor,
          requestKey: randomUUID(),
          evidenceOperationIds: [evidence.id],
        });
        assert.equal(reply.status, 200);
        f.setup = reply.data.setup as SetupDto;
        assert.equal(f.setup.state === 'ready', status === 'confirmed');
      }
    },
  ],
  [
    'passcode confirm without warning works; arbitrary mutation invalidates continuation',
    async (h) => {
      for (const mutate of [false, true]) {
        const f = await freshSetup(h);
        let stage: 'create' | 'confirm' = 'create';
        h.credentialVerifier = async () => ({ allowed: true, passcodeStage: stage, x: 50, y: 70 });
        const send = async () => {
          const read = await observe(h, f);
          return h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: {
              operationId: randomUUID(),
              operation: 'credentials.fill_device_passcode',
              args: {},
              expectedCursor: read.cursor,
              setupAttemptId: f.setup.attemptId,
              setupRevision: f.setup.revision,
            },
          });
        };
        assert.equal((await send()).data.operation?.status, 'SUCCEEDED');
        if (mutate)
          await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            method: 'POST',
            body: {
              operationId: randomUUID(),
              operation: 'input.tap',
              args: { x: 5, y: 5 },
              setupAttemptId: f.setup.attemptId,
              setupRevision: f.setup.revision,
            },
          });
        stage = 'confirm';
        const count = h.physicalOperations.filter((op) => op.op === 'input.text').length;
        assert.equal((await send()).data.operation?.status, mutate ? 'FAILED' : 'SUCCEEDED');
        assert.equal(
          h.physicalOperations.filter((op) => op.op === 'input.text').length,
          count + (mutate ? 0 : 1)
        );
      }
    },
  ],
  [
    'passcode held semantic verdict loses generation custody before registering or typing',
    async (h) => {
      const f = await freshSetup(h);
      h.credentialVerifier = async () => ({ allowed: true, passcodeStage: 'create', x: 50, y: 70 });
      h.beforeSavedExecute = async () => {
        await prisma.agent.update({
          where: { id: f.agentId },
          data: { temporalWorkflowId: randomUUID() },
        });
      };
      const read = await observe(h, f);
      const before = h.physicalOperations.filter((op) => op.op === 'input.text').length;
      const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'credentials.fill_device_passcode',
          args: {},
          expectedCursor: read.cursor,
          setupAttemptId: f.setup.attemptId,
          setupRevision: f.setup.revision,
        },
      });
      assert.equal(response.data.operation?.status, 'FAILED');
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, before);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(privacyState(device.privateInputEncrypted).active, false);
    },
  ],
  [
    'profile revision must retain possible passcode creation without allowing a new guess',
    async (h) => {
      const f = await freshSetup(h);
      h.credentialVerifier = async () => ({ allowed: true, passcodeStage: 'create', x: 50, y: 70 });
      const send = async (setup = f.setup) => {
        const read = await observe(h, f, setup);
        return h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: {
            operationId: randomUUID(),
            operation: 'credentials.fill_device_passcode',
            args: {},
            expectedCursor: read.cursor,
            setupAttemptId: setup.attemptId,
            setupRevision: setup.revision,
          },
        });
      };
      assert.equal((await send()).data.operation?.status, 'SUCCEEDED');
      const configured = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body: {
          expectedProfileRevision: f.setup.profileRevision,
          expectedAppleIdentity: f.identity,
        },
      });
      assert.equal(configured.status, 200);
      await authorizeSyntheticSetup(f);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(
        setupState(device.setupEncrypted).passcodeCreation,
        'Profile update erased possible physical passcode custody'
      );
      const current = await h.request(f.userId, `/interactions/${f.taskId}`);
      const count = h.physicalOperations.filter((op) => op.op === 'input.text').length;
      assert.equal((await send(current.data.setup as SetupDto)).data.operation?.status, 'FAILED');
      assert.equal(h.physicalOperations.filter((op) => op.op === 'input.text').length, count);
    },
  ],
  [
    'passcode unknown never replays and retains private custody',
    async (h) => {
      const f = await freshSetup(h);
      h.credentialVerifier = async () => ({ allowed: true, passcodeStage: 'create', x: 50, y: 70 });
      const read = await observe(h, f);
      const body = {
        operationId: randomUUID(),
        operation: 'credentials.fill_device_passcode',
        args: {},
        expectedCursor: read.cursor,
        setupAttemptId: f.setup.attemptId,
        setupRevision: f.setup.revision,
      };
      h.inputMode = 'unknown';
      const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        method: 'POST',
        body,
      });
      assert.equal(response.data.operation?.status, 'UNKNOWN');
      const count = h.physicalOperations.length;
      await h.request(f.userId, `/leases/${f.leaseId}/operations`, { method: 'POST', body });
      assert.equal(h.physicalOperations.length, count);
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(privacyState(device.privateInputEncrypted).active, true);
    },
  ],
];
