import { authorizeSyntheticSetup } from './iphone-control.setup-fixtures';
import { setupVerifierCases } from './iphone-control.setup-verifier.cases';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { fixture } from './auth-assistance.native-fixtures';
import type { Case } from './iphone-control.cases';

export const setupCases: Case[] = [
  ...setupVerifierCases,
  [
    'first phone task exposes setup and journals original input as terminal preexecution rejection',
    async (h) => {
      const f = await fixture(h);
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupState: 'not_started', setupEncrypted: null },
      });
      await authorizeSyntheticSetup(f);
      const interaction = await h.request(f.userId, `/interactions/${f.taskId}`);
      const setup = interaction.data.setup as {
        required: boolean;
        attemptId: string;
        revision: number;
      };
      assert.ok(setup?.required && setup.attemptId, 'Active task has no durable setup requirement');
      const operationId = randomUUID(),
        before = h.calls.length;
      const send = () =>
        h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId, operation: 'input.tap', args: { x: 1, y: 2 }, expectedCursor: 0 },
        });
      const first = await send();
      assert.equal(first.status, 200);
      assert.equal(first.data.operation?.status, 'FAILED');
      assert.equal(first.data.operation?.errorCode, 'phone_setup_required');
      assert.equal(h.calls.length, before, 'Initial task input crossed setup boundary');
      assert.equal((await send()).data.operation?.status, 'FAILED');
      assert.equal(h.calls.length, before);
    },
  ],
  [
    'setup profile route is internal-only and configured identity stays out of global capability',
    async (h) => {
      const f = await fixture(h);
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupState: 'not_started', setupEncrypted: null },
      });
      const body = {
        expectedProfileRevision: 0,
        expectedAppleIdentity: `synthetic-${randomUUID()}@example.invalid`,
      };
      assert.equal(
        (await h.request(f.userId, '/device/setup-profile', { method: 'PUT', actor: 'user', body }))
          .status,
        403
      );
      const configured = await h.request(f.userId, '/device/setup-profile', {
        method: 'PUT',
        body,
      });
      assert.equal(configured.status, 200, 'Missing internal setup profile configuration route');
      const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.ok(
        !JSON.stringify(device).includes(body.expectedAppleIdentity),
        'Setup identity persisted plaintext'
      );
      assert.ok(
        !JSON.stringify((await h.request(f.userId, '/capability')).data).includes(
          body.expectedAppleIdentity
        )
      );
    },
  ],
];
