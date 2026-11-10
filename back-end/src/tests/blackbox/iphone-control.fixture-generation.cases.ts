/** Fixture initialization is explicit; repeated requests cannot repair revoked authority. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { phoneFixtureNumber } from './phone-fixture-users';
import { syntheticConfiguration } from './iphone-control.synthetic-setup';
import type { Case } from './iphone-control.cases';
export const fixtureGenerationCases: Case[] = (['phone', 'workflow', 'firstRun'] as const).map(
  (kind) => [
    `explicit synthetic fixture cannot heal ${kind} revocation on repeated requests`,
    async (h) => {
      const f = await h.fixture();
      const context = await prisma.browserContext.upsert({
        where: { userId: f.userId },
        create: { userId: f.userId },
        update: {},
      });
      const task = await prisma.browserSession.create({
        data: { contextId: context.id, agentId: f.agentId, sessionId: randomUUID() },
      });
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { browserTaskId: task.id },
      });
      await syntheticConfiguration(f.userId, f.leaseId);
      assert.equal((await h.request(f.userId, `/availability/${task.id}`)).data.enabled, true);
      if (kind === 'phone')
        await prisma.user.update({
          where: { userId: f.userId },
          data: { phone: phoneFixtureNumber() },
        });
      else
        await prisma.agent.update({
          where: { id: f.agentId },
          data:
            kind === 'workflow'
              ? { temporalWorkflowId: randomUUID() }
              : { temporalFirstExecutionRunId: randomUUID() },
        });
      const before = (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
        .setupEncrypted;
      const calls = h.calls.length;
      for (let i = 0; i < 2; i++) {
        assert.equal((await h.request(f.userId, `/availability/${task.id}`)).data.enabled, false);
        const response = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
        });
        assert.equal(response.status, 409);
      }
      assert.equal(h.calls.length, calls, 'Revoked fixture reached provider');
      assert.equal(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupEncrypted,
        before,
        'Request helper rewrote revoked setup authority'
      );
    },
  ]
);
