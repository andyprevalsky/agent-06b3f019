/** Registered owner/auth/CAS/normal-start boundary; no live Temporal/model or physical device. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { connectionAgentHash } from '../../providers/phoneConnectionState';
import { setupState } from '../../providers/phoneSetupState';
import { openPhoneValue, sealPhoneValue } from '../../providers/phoneHarnessCredentials';
import type { Case } from './iphone-control.cases';

export const connectionCases: Case[] = [
  [
    'normal Connect iPhone is owner authenticated, idempotent, generation fenced and revocable',
    async (h) => {
      const providerCallsBefore = h.calls.length;
      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const old = setupState(device.setupEncrypted);
      assert.equal(
        (
          await h.request(f.userId, '/device/setup-profile', {
            method: 'PUT',
            body: {
              expectedProfileRevision: old.profileRevision,
              expectedAppleIdentity: 'connect-owner@example.invalid',
              expectedGoogleIdentity: 'connect-google@example.invalid',
            },
          })
        ).status,
        200
      );
      const initial = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.equal(initial.status, 200);
      assert.deepEqual(
        Object.keys(initial.data).sort(),
        [
          'accessRequested',
          'configured',
          'connectionRevision',
          'enabled',
          'setupAgentId',
          'setupProgress',
          'setupTaskId',
          'status',
        ].sort()
      );
      assert.equal(initial.data.status, 'not_connected');
      assert.equal(initial.data.setupProgress, null);
      assert.equal(initial.data.setupTaskId, null);
      const expectedRevision = initial.data.connectionRevision;
      const requestKey = randomUUID();
      let created = 0;
      h.setupAgentLauncher = async (userId, deviceId, reservation) => {
        assert.equal(userId, f.userId);
        assert.equal(deviceId, f.deviceId);
        const existing = await prisma.agent.findUnique({ where: { id: reservation.agentId } });
        if (existing) return;
        created++;
        await prisma.agent.create({
          data: {
            id: reservation.agentId,
            userId,
            status: 'ACTIVE',
            goal: 'Synthetic normal root launch boundary',
            temporalWorkflowId: reservation.agentId,
            temporalFirstExecutionRunId: randomUUID(),
            temporalWorkflowStartPending: false,
          },
        });
        await prisma.message.create({
          data: {
            agentId: reservation.agentId,
            role: 'USER',
            text: 'Synthetic trusted normal goal',
            metadata: { iphone_setup_hash: connectionAgentHash(userId, deviceId, reservation) },
          },
        });
      };
      const connect = () =>
        h.request(f.userId, '/connect', {
          actor: 'user',
          method: 'POST',
          body: { requestKey, expectedRevision },
        });
      const started = await connect();
      assert.equal(started.status, 200);
      const id = started.data.setupAgentId as string;
      assert.ok(id);
      assert.equal((await connect()).data.setupAgentId, id);
      assert.equal(created, 1);
      assert.equal(
        (
          await h.request(f.userId, '/connect', {
            actor: 'user',
            method: 'POST',
            body: { requestKey: randomUUID(), expectedRevision },
          })
        ).status,
        409
      );
      assert.equal(
        (
          await h.request(f.userId, '/connect', {
            actor: 'user',
            method: 'POST',
            body: { requestKey: randomUUID(), expectedRevision, ready: true },
          })
        ).status,
        400
      );
      const context = await prisma.browserContext.upsert({
        where: { userId: f.userId },
        create: { userId: f.userId },
        update: {},
      });
      const task = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: id, sessionId: randomUUID() },
      });
      assert.equal(
        (await h.request(f.userId, `/availability/${task.id}`)).data.source,
        'bootstrap'
      );
      const userDeniedProfile = await h.request(f.userId, '/device/setup-profile', {
        actor: 'user',
        method: 'PUT',
        body: { expectedProfileRevision: 2, expectedAppleIdentity: 'forged' },
      });
      assert.equal(userDeniedProfile.status, 403);
      const acquired = await h.request(f.userId, `/interactions/${task.id}`, {
        method: 'POST',
        body: { requestKey: randomUUID() },
      });
      assert.equal(acquired.status, 200);
      const setup = acquired.data.setup as { attemptId: string; revision: number };
      assert.ok(
        setup.revision > (started.data.connectionRevision as number),
        'first lease advances setup claim revision'
      );
      assert.equal(
        (await h.request(f.userId, `/availability/${task.id}`)).data.source,
        'bootstrap',
        'legitimate first-lease revision does not revoke exact bootstrap'
      );
      const a = await prisma.agent.findUniqueOrThrow({ where: { id } });
      await prisma.agent.update({
        where: { id },
        data: { temporalFirstExecutionRunId: randomUUID() },
      });
      assert.equal(
        (await h.request(f.userId, `/availability/${task.id}`)).data.enabled,
        false,
        'same Workflow ID with new run cannot borrow bootstrap'
      );
      await prisma.agent.update({
        where: { id },
        data: { temporalFirstExecutionRunId: a.temporalFirstExecutionRunId },
      });
      assert.equal(
        (
          await h.request(f.userId, `/interactions/${task.id}/setup`, {
            method: 'POST',
            body: {
              action: 'block',
              attemptId: setup.attemptId,
              expectedRevision: setup.revision,
              expectedCursor: 0,
              requestKey: randomUUID(),
              reasonCode: 'observed_signed_out',
            },
          })
        ).status,
        200
      );
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'needs_reauth'
      );
      assert.equal((await h.request(f.userId, `/availability/${task.id}`)).data.enabled, false);
      assert.equal((await connect()).status, 409, 'old request cannot undo newer trusted signout');
      const foreign = await h.fixture();
      assert.equal(
        (await h.request(foreign.userId, `/availability/${task.id}`, { actor: 'user' })).status,
        404
      );
      assert.equal(
        h.calls.length,
        providerCallsBefore,
        'setup admission/verification control must not touch synthetic phone provider'
      );
    },
  ],
  [
    'a paused setup agent no longer holds Connect: status is not_connected and Connect relaunches',
    async (h) => {
      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const old = setupState(device.setupEncrypted);
      assert.equal(
        (
          await h.request(f.userId, '/device/setup-profile', {
            method: 'PUT',
            body: {
              expectedProfileRevision: old.profileRevision,
              expectedAppleIdentity: 'paused-owner@example.invalid',
              expectedGoogleIdentity: 'paused-google@example.invalid',
            },
          })
        ).status,
        200
      );
      const launched: string[] = [];
      h.setupAgentLauncher = async (userId, _deviceId, reservation) => {
        if (await prisma.agent.findUnique({ where: { id: reservation.agentId } })) return;
        launched.push(reservation.agentId);
        await prisma.agent.create({
          data: {
            id: reservation.agentId,
            userId,
            status: 'ACTIVE',
            goal: 'Synthetic setup agent',
            temporalWorkflowId: reservation.agentId,
            temporalFirstExecutionRunId: randomUUID(),
            temporalWorkflowStartPending: false,
          },
        });
      };
      const connect = async () => {
        const revision = (await h.request(f.userId, '/connection', { actor: 'user' })).data
          .connectionRevision;
        return h.request(f.userId, '/connect', {
          actor: 'user',
          method: 'POST',
          body: { requestKey: randomUUID(), expectedRevision: revision },
        });
      };
      const first = await connect();
      assert.equal(first.status, 200);
      const firstAgent = first.data.setupAgentId as string;
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'setting_up'
      );
      await prisma.agent.update({ where: { id: firstAgent }, data: { status: 'PAUSED' } });
      // A private phase left by an ended user-control session (the production incident) must not
      // stall the relaunched setup: Connect is the owner's explicit hand-off of the phone.
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: {
          privateInputEncrypted: sealPhoneValue({ version: 1, active: true, values: ['typed'] }),
        },
      });
      const stalled = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.equal(
        stalled.data.status,
        'not_connected',
        'a paused setup agent must not pin setting_up'
      );
      const privacyOf = async () =>
        openPhoneValue<{ active: boolean; values: string[] }>(
          (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
            .privateInputEncrypted as string
        );
      // An unresolved private input still holds device custody: Connect relaunches setup but
      // must not lift the private phase over it.
      const unknownInput = await prisma.iPhoneOperation.create({
        data: {
          deviceId: f.deviceId,
          leaseId: f.leaseId,
          requestKey: randomUUID(),
          operation: 'input.text',
          actor: 'agent',
          inputHash: 'synthetic',
          requestEncrypted: sealPhoneValue({}),
          state: 'UNKNOWN',
          activeDeviceId: f.deviceId,
          providerEpoch: 0,
          deadlineAt: new Date(),
        },
      });
      const second = await connect();
      assert.equal(second.status, 200);
      assert.notEqual(
        second.data.setupAgentId,
        firstAgent,
        'Connect must start a fresh setup agent'
      );
      assert.deepEqual(launched, [firstAgent, second.data.setupAgentId]);
      assert.equal(
        (await privacyOf()).active,
        true,
        'Connect lifted privacy over an unresolved private input'
      );
      await prisma.iPhoneOperation.delete({ where: { id: unknownInput.id } });
      await prisma.agent.update({
        where: { id: second.data.setupAgentId as string },
        data: { status: 'PAUSED' },
      });
      const third = await connect();
      assert.equal(third.status, 200);
      assert.deepEqual(launched, [firstAgent, second.data.setupAgentId, third.data.setupAgentId]);
      const privacy = await privacyOf();
      assert.equal(privacy.active, false, 'Connect left the phone in a private phase');
      assert.deepEqual(privacy.values, ['typed'], 'Connect must keep known secrets for redaction');
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'setting_up'
      );
    },
  ],
  [
    'an owner-deleted setup agent ends setup: status is not_connected and Connect relaunches; a foreign agent still 409s',
    async (h) => {
      const f = await h.fixture();
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      const old = setupState(device.setupEncrypted);
      assert.equal(
        (
          await h.request(f.userId, '/device/setup-profile', {
            method: 'PUT',
            body: {
              expectedProfileRevision: old.profileRevision,
              expectedAppleIdentity: 'deleted-owner@example.invalid',
              expectedGoogleIdentity: 'deleted-google@example.invalid',
            },
          })
        ).status,
        200
      );
      const launched: string[] = [];
      h.setupAgentLauncher = async (userId, _deviceId, reservation) => {
        if (await prisma.agent.findUnique({ where: { id: reservation.agentId } })) return;
        launched.push(reservation.agentId);
        await prisma.agent.create({
          data: {
            id: reservation.agentId,
            userId,
            status: 'ACTIVE',
            goal: 'Synthetic setup agent',
            temporalWorkflowId: reservation.agentId,
            temporalFirstExecutionRunId: randomUUID(),
            temporalWorkflowStartPending: false,
          },
        });
      };
      const connect = async () => {
        const revision = (await h.request(f.userId, '/connection', { actor: 'user' })).data
          .connectionRevision;
        return h.request(f.userId, '/connect', {
          actor: 'user',
          method: 'POST',
          body: { requestKey: randomUUID(), expectedRevision: revision },
        });
      };
      const first = await connect();
      assert.equal(first.status, 200);
      const firstAgent = first.data.setupAgentId as string;
      // The production incident: the owner soft-deleted the reserved setup agent.
      await prisma.agent.update({
        where: { id: firstAgent },
        data: { status: 'FAILED', deletedAt: new Date() },
      });
      const ended = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.equal(ended.status, 200, 'a deleted setup agent must not wedge the connection');
      assert.equal(ended.data.status, 'not_connected');
      const second = await connect();
      assert.equal(second.status, 200, 'Connect must not be wedged by a deleted setup agent');
      assert.notEqual(second.data.setupAgentId, firstAgent);
      assert.deepEqual(launched, [firstAgent, second.data.setupAgentId]);
      assert.equal(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { userId: f.userId } })).id,
        f.deviceId,
        'Connect must keep the bound device'
      );
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.status,
        'setting_up'
      );
      // A reservation pointing at another user's agent is still refused.
      const foreign = await h.fixture();
      const revision = (await h.request(f.userId, '/connection', { actor: 'user' })).data
        .connectionRevision;
      await prisma.agent.update({
        where: { id: second.data.setupAgentId as string },
        data: { userId: foreign.userId },
      });
      assert.equal((await h.request(f.userId, '/connection', { actor: 'user' })).status, 409);
      const refused = await h.request(f.userId, '/connect', {
        actor: 'user',
        method: 'POST',
        body: { requestKey: randomUUID(), expectedRevision: revision },
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.data.error, 'iPhone setup agent is unavailable');
      assert.deepEqual(launched, [firstAgent, second.data.setupAgentId]);
    },
  ],
  [
    'disabled Connect iPhone cannot start an agent or receive private grants',
    async (h) => {
      const f = await h.fixture();
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      let launches = 0;
      h.setupAgentLauncher = async () => {
        launches++;
      };
      const before = await prisma.agent.count({ where: { userId: f.userId } });
      const dto = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.equal(dto.data.enabled, false);
      assert.equal(dto.data.setupAgentId, null);
      const response = await h.request(f.userId, '/connect', {
        actor: 'user',
        method: 'POST',
        body: { requestKey: randomUUID(), expectedRevision: 0 },
      });
      assert.equal(response.status, 403);
      assert.equal(launches, 0);
      assert.equal(await prisma.agent.count({ where: { userId: f.userId } }), before);
      const unauth = await fetch(`${h.base}/api/iphone/connection`);
      assert.equal(unauth.status, 401);
    },
  ],
];
