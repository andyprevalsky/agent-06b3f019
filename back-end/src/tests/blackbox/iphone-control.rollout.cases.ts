import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';
import { fixture } from './auth-assistance.native-fixtures';
import { getTaskInfo } from '../../domains/browser-session/service.task-info';
import { toUserSettings } from '../../domains/browser-session/service.serializers';
export const rolloutCases: Case[] = [
  [
    'browser init and resume piggyback optional rollout without other response changes',
    async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '--experimental-test-module-mocks',
          '--import',
          'tsx',
          'src/tests/blackbox/browser-session-phone-rollout.fixture.ts',
        ],
        { env: process.env, maxBuffer: 2_000_000 }
      );
      assert.equal(
        stdout.includes('model=IPhone'),
        false,
        'Browser metadata performed independent phone DB discovery'
      );
    },
  ],
  [
    'rollout default off denies phone before provider and hides optional profile marker',
    async (h) => {
      const saved = process.env.CLOUD_IPHONE_ENABLED;
      process.env.CLOUD_IPHONE_ENABLED = '1';
      const f = await fixture(h);
      const user = await prisma.user.findUniqueOrThrow({ where: { userId: f.userId } });
      const settings = async () => {
        const response = await fetch(`${h.base}/api/user-settings`, {
          headers: {
            'X-API-Key': process.env.BACKEND_API_KEY ?? '',
            'X-User-Id': f.userId,
          },
        });
        assert.equal(response.status, 200);
        return (await response.json()) as Record<string, unknown>;
      };
      try {
        delete process.env.CLOUD_IPHONE_ENABLED;
        const before = h.calls.length;
        const clientsBefore = h.clientCreations;
        const off = await settings();
        assert.equal(Object.hasOwn(off, 'iphoneCapability'), false);
        assert.equal(Object.hasOwn(toUserSettings(user)!, 'iphoneCapability'), false);
        const denied = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
        });
        assert.ok([403, 409].includes(denied.status), 'Flag-off phone operation was admitted');
        assert.equal(h.calls.length, before, 'Flag-off path created or called provider');
        assert.equal(h.clientCreations, clientsBefore, 'Flag-off path constructed provider client');
        assert.equal(
          (await h.request(f.userId, '/', { api: 'auth-assistance', method: 'POST', body: f.body }))
            .status,
          403
        );

        for (const flag of ['true', '1']) {
          process.env.CLOUD_IPHONE_ENABLED = flag;
          assert.deepEqual((await settings()).iphoneCapability, { enabled: true });
          assert.deepEqual((await getTaskInfo(f.taskId))?.user_settings?.iphoneCapability, {
            enabled: true,
          });
          assert.deepEqual(
            (toUserSettings(user) as unknown as Record<string, unknown>).iphoneCapability,
            { enabled: true }
          );
        }
        const replacement = await h.acquire(f.userId, f.agentId);
        f.leaseId = replacement.id;
        await prisma.iPhoneLease.update({
          where: { id: f.leaseId },
          data: { browserTaskId: f.taskId },
        });
        assert.equal(
          (
            await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
              method: 'POST',
              body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
            })
          ).data.operation?.status,
          'SUCCEEDED'
        );
        await prisma.user.update({ where: { userId: f.userId }, data: { phone: '+15555550123' } });
        const ineligible = await settings();
        process.env.CLOUD_IPHONE_ENABLED = '0';
        assert.deepEqual(await settings(), ineligible, 'Ineligible profile bytes changed');
        process.env.CLOUD_IPHONE_ENABLED = '1';
        const foreign = await prisma.user.findUniqueOrThrow({ where: { userId: f.userId } });
        assert.equal(Object.hasOwn(toUserSettings(foreign)!, 'iphoneCapability'), false);
        process.env.CLOUD_IPHONE_ENABLED = '0';
        h.cleanupComplete = true;
        const released = await h.request(f.userId, `/leases/${f.leaseId}/release`, {
          method: 'POST',
        });
        assert.equal(released.status, 200);
        const cleaned = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        assert.equal(cleaned.providerState, 'IDLE');
        assert.equal(cleaned.providerSessionEncrypted, null);
        assert.ok(
          h.calls.some((call) => call.method === 'DELETE'),
          'Existing provider session was not stopped after gate off'
        );

        assert.equal(
          (await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
          200
        );
      } finally {
        if (saved === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
        else process.env.CLOUD_IPHONE_ENABLED = saved;
      }
    },
  ],
];
