import { syntheticConfiguration } from './iphone-control.synthetic-setup';
import { authorizeSyntheticSetup } from './iphone-control.setup-fixtures';
import { fixture } from './auth-assistance.native-fixtures';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { privacyState, rememberPrivate } from '../../providers/phoneInputPrivacy';
import { USER_CONTROL_TIMEOUT_MS } from '../../providers/phoneAccountPolicy';
import { prisma } from '../../providers/database';
import type { Harness } from './iphone-control.fixtures';
import type { Case } from './iphone-control.cases';

type Fixture = Awaited<ReturnType<typeof fixture>>;

const privacy = async (deviceId: string) =>
  privacyState(
    (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: deviceId } })).privateInputEncrypted
  );

/** Expire a hold past its user grace; cleanup proof covers only the session that ends. */
async function expire(h: Harness, f: Fixture, leaseId: string) {
  await prisma.iPhoneLease.update({
    where: { id: leaseId },
    data: { leaseExpiresAt: new Date(0) },
  });
  h.cleanupComplete = true;
  assert.equal((await h.request(f.userId, `/leases/${leaseId}`)).status, 200);
  h.cleanupComplete = false;
  const expired = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: leaseId } });
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(expired.controlOwner, 'agent');
}

/** Give a successor agent lease its own setup authority, then read the screen as the agent. */
async function agentRead(h: Harness, f: Fixture, agentId: string, leaseId: string) {
  const context = await prisma.browserContext.findUniqueOrThrow({ where: { userId: f.userId } });
  const task = await prisma.browserSession.create({
    data: { contextId: context.id, agentId, sessionId: randomUUID() },
  });
  await prisma.iPhoneLease.update({ where: { id: leaseId }, data: { browserTaskId: task.id } });
  await syntheticConfiguration(f.userId, leaseId);
  await authorizeSyntheticSetup({ ...f, agentId });
  return h.request(f.userId, `/leases/${leaseId}/operations`, {
    method: 'POST',
    body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
  });
}

export const privacyExpiryCases: Case[] = [
  [
    'expired user-held phone auth lease ends the private phase for the next agent lease',
    async (h) => {
      // Prod 2026-11-15 (agent 87c1e09a): owner typed during native phone auth, never handed
      // back; the lease EXPIRED after the user grace and every successor agent op returned 409.
      const f = await fixture(h);
      await authorizeSyntheticSetup(f);
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { setupState: 'in_progress' },
      });
      const created = await h.request(f.userId, '/', {
        api: 'auth-assistance',
        method: 'POST',
        body: f.body,
      });
      assert.equal(created.status, 201, 'Native phone attention was not created');
      const attentionRequestId = (created.data.request as { id: string }).id;
      const canary = `expired-private-${randomUUID()}`;
      const typed = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: {
          operationId: randomUUID(),
          operation: 'input.text',
          args: { s: canary },
          expectedCursor: 0,
          attentionRequestId,
        },
      });
      assert.equal(typed.status, 200);
      const agent = await h.createAgent(f.userId);
      const waiter = await h.acquire(f.userId, agent.id);
      assert.equal(waiter.status, 'WAITING', 'Successor took the phone during user control');
      // Negative control: heartbeat expiry inside the user grace keeps the hold and the phase.
      await prisma.iPhoneLease.update({
        where: { id: f.leaseId },
        data: { leaseExpiresAt: new Date(Date.now() - USER_CONTROL_TIMEOUT_MS / 2) },
      });
      assert.equal((await h.request(f.userId, `/leases/${waiter.id}`)).status, 200);
      const held = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } });
      assert.equal(held.status, 'ACTIVE', 'User grace was cut short');
      assert.equal((await privacy(f.deviceId)).active, true, 'Phase ended inside the user grace');
      await expire(h, f, f.leaseId);
      assert.equal((await h.request(f.userId, `/leases/${waiter.id}`)).status, 200);
      const next = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: waiter.id } });
      assert.equal(next.status, 'ACTIVE');
      h.observationResult = { text: `Passcode ${canary}` };
      const read = await agentRead(h, f, agent.id, next.id);
      assert.equal(
        read.status,
        200,
        `Successor agent wedged after user lease expiry: ${JSON.stringify(read.data)}`
      );
      assert.ok(!JSON.stringify(read.data).includes(canary), 'Expiry dropped value redaction');
      const state = await privacy(f.deviceId);
      assert.equal(state.active, false);
      assert.ok(state.values.includes(canary), 'Expiry evicted the submitted-value vault');
    },
  ],
  [
    'a successor cannot end an inherited private phase by letting its own user hold expire',
    async (h) => {
      const f = await fixture(h);
      await authorizeSyntheticSetup(f);
      const control = (leaseId: string, mode: 'user' | 'agent', actor?: 'user') =>
        h.request(f.userId, `/leases/${leaseId}/control`, {
          method: 'POST',
          body: { mode },
          ...(actor === undefined ? {} : { actor }),
        });
      assert.equal((await control(f.leaseId, 'user', 'user')).status, 200);
      const typed = await h.request(f.userId, `/leases/${f.leaseId}/operations`, {
        actor: 'user',
        method: 'POST',
        body: { operationId: randomUUID(), operation: 'input.text', args: { s: randomUUID() } },
      });
      assert.equal(typed.status, 200);
      h.cleanupComplete = true;
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST', actor: 'user' });
      h.cleanupComplete = false;
      const successor = await h.createAgent(f.userId);
      const inherited = await h.acquire(f.userId, successor.id);
      assert.equal(inherited.status, 'ACTIVE');
      // The agent itself flips its lease to user control, then idles past the user grace.
      assert.equal((await control(inherited.id, 'user')).status, 200);
      await expire(h, f, inherited.id);
      assert.equal((await privacy(f.deviceId)).active, true, 'Successor expiry cleared phase');
      const third = await h.createAgent(f.userId);
      const lease = await h.acquire(f.userId, third.id);
      assert.equal(lease.status, 'ACTIVE');
      const denied = await agentRead(h, f, third.id, lease.id);
      assert.equal(denied.status, 409, 'Inherited private phase was implicitly cleared');
      assert.ok(JSON.stringify(denied.data).includes('Phone private input is active'));
    },
  ],
  [
    'an agent-opened private phase survives the agent expiring its own user hold',
    async (h) => {
      const f = await fixture(h);
      await authorizeSyntheticSetup(f);
      // Passcode and saved-credential fills open the phase with no user opener.
      await prisma.iPhoneDevice.update({
        where: { id: f.deviceId },
        data: { privateInputEncrypted: rememberPrivate(null, `agent-fill-${randomUUID()}`) },
      });
      const flipped = await h.request(f.userId, `/leases/${f.leaseId}/control`, {
        method: 'POST',
        body: { mode: 'user' },
      });
      assert.equal(flipped.status, 200);
      await expire(h, f, f.leaseId);
      assert.equal((await privacy(f.deviceId)).active, true, 'Agent cleared its own private phase');
    },
  ],
];
