import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';
import { freshSetup } from './iphone-control.setup-fixtures';
export const messageQueueCases: Case[] = [
  [
    'cloud queue transport and immutable task binding exclude Mac relay',
    async (h) => {
      const f = await freshSetup(h);
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(`${h.base}/api/imessage${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.BACKEND_API_KEY ?? '',
            'X-User-Id': f.userId,
            'X-CloudBench-iMessage-Relay': 'v1',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          data:
            response.headers.get('content-type')?.includes('application/json') === true
              ? ((await response.json()) as Record<string, unknown>)
              : {},
        };
      };
      const body = {
        user_id: f.userId,
        agent_id: f.agentId,
        phone_number: '+15555550123',
        message: 'Approved queue route body',
        idempotency_key: randomUUID(),
      };
      const created = await api('/queue', body);
      assert.equal(created.status, 200);
      assert.equal(created.data.provider, 'phone_harness');
      const id = created.data.queue_id as string;
      assert.equal((await api('/queue', { ...body, message: 'Changed intent' })).status, 409);
      assert.equal(
        (await api(`/queue/${id}/phone-bind`, { user_id: f.userId, browser_task_id: randomUUID() }))
          .status,
        409
      );
      const failedTransaction = mock.method(prisma, '$transaction', async () => {
        throw new Error('fixture database unavailable');
      });
      try {
        assert.equal(
          (await api(`/queue/${id}/phone-bind`, { user_id: f.userId, browser_task_id: f.taskId }))
            .status,
          500,
          'Database infrastructure failure must not be reported as a task-binding conflict'
        );
      } finally {
        failedTransaction.mock.restore();
      }
      const bound = await api(`/queue/${id}/phone-bind`, {
        user_id: f.userId,
        browser_task_id: f.taskId,
      });
      assert.equal(bound.status, 200);
      const second = await api('/queue', { ...body, idempotency_key: randomUUID() });
      assert.equal(
        (
          await api(`/queue/${second.data.queue_id as string}/phone-bind`, {
            user_id: f.userId,
            browser_task_id: f.taskId,
          })
        ).status,
        409
      );
      assert.equal((await api('/queue/pop')).data.message, null, 'Mac relay consumed cloud queue');
      const old = process.env.CLOUD_IPHONE_ENABLED;
      process.env.CLOUD_IPHONE_ENABLED = '0';
      try {
        const mac = await api('/queue', { ...body, idempotency_key: randomUUID() });
        assert.equal(mac.status, 200);
        assert.equal(Object.hasOwn(mac.data, 'provider'), false);
        assert.equal(
          (
            await prisma.imessageQueue.findUniqueOrThrow({
              where: { id: mac.data.queue_id as string },
            })
          ).transport,
          'mac'
        );
      } finally {
        process.env.CLOUD_IPHONE_ENABLED = old;
      }
    },
  ],
];
