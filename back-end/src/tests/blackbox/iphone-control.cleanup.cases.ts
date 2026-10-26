import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';
import { Harness } from './iphone-control.fixtures';

function lease(data: Record<string, unknown>) {
  return data.lease as { status: string };
}
function operation(data: Record<string, unknown>) {
  return data.operation as { status: string };
}
function send(h: Harness, userId: string, leaseId: string) {
  return h.request(userId, `/leases/${leaseId}/operations`, {
    method: 'POST',
    body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
  });
}
async function queued(h: Harness, userId: string) {
  const agent = await h.createAgent(userId);
  const next = await h.acquire(userId, agent.id);
  assert.equal(next.status, 'WAITING');
  return next;
}

export const cleanupCases: Case[] = [
  [
    'successful idle session is stopped and confirmed after last lease release',
    async (h) => {
      const f = await h.fixture();
      assert.equal(operation((await send(h, f.userId, f.leaseId)).data).status, 'SUCCEEDED');
      const before = h.calls.length;
      h.beforeStop = async () => {
        const fenced = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        assert.equal(fenced.providerState, 'CLOSING', 'Stop preceded durable closing fence');
        assert.ok(fenced.providerStartKey && fenced.providerSessionEncrypted);
      };
      h.cleanupComplete = true;
      const released = await h.request(f.userId, `/leases/${f.leaseId}/release`, {
        method: 'POST',
      });
      assert.equal(released.status, 200);
      assert.equal(lease(released.data).status, 'RELEASED');
      assert.ok(
        h.calls.slice(before).some((c) => c.method === 'DELETE'),
        'Successful idle session was not stopped'
      );
      assert.ok(
        h.calls.slice(before).some((c) => c.path.startsWith('/sessions/requests/')),
        'Cleanup was not confirmed by recovery'
      );
      const d = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(d.providerState, 'IDLE');
      assert.equal(d.providerStartKey, null);
      assert.equal(d.providerSessionId, null);
      assert.equal(d.providerSessionEncrypted, null);
    },
  ],
  [
    'idle cleanup retains fence until proof and rejects foreign release without provider access',
    async (h) => {
      const f = await h.fixture(),
        other = await h.fixture();
      await send(h, f.userId, f.leaseId);
      const before = h.calls.length;
      assert.equal(
        (await h.request(other.userId, `/leases/${f.leaseId}/release`, { method: 'POST' })).status,
        404
      );
      assert.equal(
        (await h.request(f.userId, `/leases/${randomUUID()}/release`, { method: 'POST' })).status,
        404
      );
      assert.equal(h.calls.length, before);
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      const d = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(d.providerState, 'CLOSING');
      assert.ok(d.providerStartKey && d.providerSessionEncrypted);
      const creates = h.calls.filter((c) => c.method === 'POST' && c.path === '/sessions').length;
      const physical = h.physicalOperations.length;
      const a = await h.createAgent(f.userId);
      const next = await h.acquire(f.userId, a.id);
      assert.equal(next.status, 'WAITING');
      assert.equal((await send(h, f.userId, next.id)).status, 409);
      assert.equal(h.physicalOperations.length, physical);
      assert.equal(
        h.calls.filter((c) => c.method === 'POST' && c.path === '/sessions').length,
        creates
      );
      h.cleanupComplete = true;
      assert.equal(lease((await h.request(f.userId, `/leases/${next.id}`)).data).status, 'ACTIVE');
      const cleared = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
      assert.equal(cleared.providerState, 'IDLE');
      assert.equal(cleared.providerSessionEncrypted, null);
    },
  ],
  [
    'successful session is retained for valid active owner and FIFO successor',
    async (h) => {
      const f = await h.fixture();
      await send(h, f.userId, f.leaseId);
      const next = await queued(h, f.userId);
      const before = h.calls.length;
      await h.request(f.userId, `/leases/${f.leaseId}`);
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      assert.equal(lease((await h.request(f.userId, `/leases/${next.id}`)).data).status, 'ACTIVE');
      assert.equal(operation((await send(h, f.userId, next.id)).data).status, 'SUCCEEDED');
      await h.request(f.userId, `/leases/${f.leaseId}/release`, { method: 'POST' });
      assert.ok(
        !h.calls.slice(before).some((c) => c.method === 'DELETE'),
        'Stopped a valid successor session'
      );
    },
  ],
];

cleanupCases.push([
  'terminal agent idle session is cleaned through owned lease read',
  async (h) => {
    const f = await h.fixture();
    await send(h, f.userId, f.leaseId);
    await prisma.agent.update({ where: { id: f.agentId }, data: { status: 'COMPLETED' } });
    h.cleanupComplete = true;
    const before = h.calls.length;
    assert.equal((await h.request(f.userId, `/leases/${f.leaseId}`)).status, 200);
    assert.ok(h.calls.slice(before).some((c) => c.method === 'DELETE'));
    const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
    assert.equal(device.providerState, 'IDLE');
    assert.equal(device.providerStartKey, null);
    assert.equal(device.providerSessionId, null);
    assert.equal(device.providerSessionEncrypted, null);
  },
]);
