import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { openPhoneValue } from '../../providers/phoneHarnessCredentials';
import { privacyState } from '../../providers/phoneInputPrivacy';
import { fixture, withPhone } from './auth-assistance.native-fixtures';
import { nativeBoundaryTests } from './auth-assistance.native-boundaries';

interface NativeData {
  request: {
    id: string;
    target: unknown;
    criticalReason: string;
    steelSessionId: string;
    browserSessionId: null;
  };
  handoff: { target: unknown; liveViewUrl: null; steelSessionId: null };
  target: unknown;
  authAssistance: { target: unknown };
  requestUserAuthentication: { target: unknown };
}
type Test = [string, () => Promise<void>];
export const authAssistanceNativeTests: Test[] = [
  ...nativeBoundaryTests,
  [
    'native assistance atomically binds exact task without browser URL and retries same request',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const responses = await Promise.all(
          [0, 1].map(() =>
            h.request(f.userId, '/', { api: 'auth-assistance', method: 'POST', body: f.body })
          )
        );
        responses.forEach((r) => assert.equal(r.status, 201));
        const first = responses[0].data as unknown as NativeData;
        assert.deepEqual(
          first.request.target,
          { kind: 'iphone', browserTaskId: f.taskId, leaseId: f.leaseId },
          'Native request lost exact target'
        );
        assert.deepEqual(first.handoff.target, first.request.target);
        assert.equal(first.request.criticalReason, 'password');
        assert.equal(first.handoff.liveViewUrl, null);
        assert.equal(first.handoff.steelSessionId, null);
        assert.equal(first.request.steelSessionId, '');
        assert.equal(first.request.browserSessionId, null);
        assert.equal((responses[1].data as unknown as NativeData).request.id, first.request.id);
        assert.equal(
          await prisma.userAuthAssistanceRequest.count({ where: { agentId: f.agentId } }),
          1
        );
        const attention = await prisma.agentAttentionRequest.findUniqueOrThrow({
          where: { id: first.request.id },
        });
        const metadata = attention.metadata as unknown as NativeData;
        assert.deepEqual(metadata.target, first.request.target);
        assert.deepEqual(metadata.authAssistance.target, first.request.target);
        assert.deepEqual(metadata.requestUserAuthentication.target, first.request.target);
        assert.ok(!JSON.stringify(metadata).includes('browser.invalid'));
        const lease = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } });
        assert.equal(lease.attentionRequestId, first.request.id);
        assert.equal(lease.controlOwner, 'user');
        const handback = await h.request(f.userId, `/leases/${f.leaseId}/control`, {
          actor: 'user',
          method: 'POST',
          body: { mode: 'agent' },
        });
        assert.equal(handback.status, 409, 'Generic handback bypassed native completion');
      }),
  ],
  [
    'native assistance rejects stale cursor and same-user wrong agent/task before creation',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const other = await h.createAgent(f.userId);
        for (const body of [
          { ...f.body, expectedCursor: 1 },
          { ...f.body, agentId: other.id },
          { ...f.body, browserTaskId: randomUUID() },
        ]) {
          const response = await h.request(f.userId, '/', {
            api: 'auth-assistance',
            method: 'POST',
            body,
          });
          assert.ok([404, 409].includes(response.status), 'Invalid native binding accepted');
        }
        assert.equal(
          await prisma.userAuthAssistanceRequest.count({ where: { agentId: f.agentId } }),
          0
        );
      }),
  ],
  [
    'native generic attention response rejects raw text and authored messages',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        for (const body of [
          { response: 'raw-private-text' },
          { response: '__AUTH_ASSISTANCE_COMPLETED__', user_message: 'unregistered private reply' },
          { response: '__REJECTED__', user_message: 'private reply' },
        ]) {
          const id = randomUUID();
          await prisma.agentAttentionRequest.create({
            data: {
              id,
              userId: f.userId,
              agentId: f.agentId,
              workflowId: f.agentId,
              question: 'Native phone protected entry',
              metadata: {
                target: { kind: 'iphone', browserTaskId: f.taskId, leaseId: f.leaseId },
                authAssistance: {
                  target: { kind: 'iphone', browserTaskId: f.taskId, leaseId: f.leaseId },
                },
              },
            },
          });
          await prisma.userAuthAssistanceRequest.create({
            data: {
              id,
              userId: f.userId,
              agentId: f.agentId,
              authRealm: 'iphone',
              mode: 'manual_step',
              steelSessionId: '',
            },
          });
          const response = await fetch(
            `${process.env.TEST_BASE_URL}/api/attention-requests/${id}/respond`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': process.env.BACKEND_API_KEY ?? '',
                'X-User-Id': f.userId,
              },
              body: JSON.stringify(body),
            }
          );
          assert.equal(response.status, 403, 'Native raw attention response was accepted');
          assert.equal(
            (await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id } })).userResponse,
            null
          );
          assert.equal(
            await prisma.message.count({ where: { agentId: f.agentId, role: 'USER' } }),
            0
          );
        }
      }),
  ],
  [
    'native reject endpoint refuses authored private message',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        assert.equal(created.status, 201);
        const id = (created.data.request as { id: string }).id;
        const response = await fetch(
          `${process.env.TEST_BASE_URL}/api/attention-requests/${id}/reject`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': process.env.BACKEND_API_KEY ?? '',
              'X-User-Id': f.userId,
            },
            body: JSON.stringify({ message: 'synthetic private rejected reply' }),
          }
        );
        assert.equal(response.status, 403, 'Native rejection persisted a private user message');
        assert.equal(
          (await prisma.agentAttentionRequest.findUniqueOrThrow({ where: { id } })).userResponse,
          null
        );
        assert.equal(
          await prisma.message.count({ where: { agentId: f.agentId, role: 'USER' } }),
          0
        );
      }),
  ],
  [
    'native input exact binding and completion preserve privacy, cursor and browser state',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        await prisma.iPhoneDevice.update({
          where: { id: f.deviceId },
          data: { setupState: 'in_progress' },
        });
        const beforeBrowser = await prisma.browserSession.findUniqueOrThrow({
          where: { id: f.taskId },
        });
        const create = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        assert.equal(create.status, 201);
        const id = (create.data.request as { id: string }).id;
        assert.equal(
          (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).setupState,
          'awaiting_user'
        );
        assert.equal(
          privacyState(
            (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } }))
              .privateInputEncrypted
          ).active,
          true
        );
        const operationId = randomUUID(),
          canary = `native-private-${randomUUID()}`;
        const op = (attentionRequestId?: string) =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            actor: 'user',
            method: 'POST',
            body: {
              operationId,
              operation: 'input.text',
              args: { s: canary },
              expectedCursor: 0,
              ...(attentionRequestId === undefined ? {} : { attentionRequestId }),
            },
          });
        const calls = h.calls.length;
        assert.equal((await op()).status, 409);
        assert.equal((await op(randomUUID())).status, 409);
        assert.equal(h.calls.length, calls, 'Wrong request binding reached provider');
        assert.equal((await op(id)).status, 200);
        const replay = await op(id);
        assert.equal(replay.status, 200);
        assert.equal(h.physicalOperations.filter((call) => call.kw.s === canary).length, 1);
        const stored = await prisma.iPhoneOperation.findFirstOrThrow({
          where: { leaseId: f.leaseId, requestKey: operationId },
        });
        assert.equal(
          openPhoneValue<{ attentionRequestId: string }>(stored.requestEncrypted)
            .attentionRequestId,
          id
        );
        const status = await h.request(f.userId, `/leases/${f.leaseId}/operations/${operationId}`);
        assert.equal(status.data.operation?.status, 'SUCCEEDED');
        assert.ok(!JSON.stringify([replay.data, status.data, stored]).includes(canary));
        const refresh = await h.request(f.userId, `/${id}/refresh-session`, {
          api: 'auth-assistance',
          method: 'POST',
        });
        assert.equal(refresh.status, 200);
        assert.equal(refresh.data.refreshed, false);
        for (const userMessage of ['synthetic-private-message']) {
          const denied = await h.request(f.userId, `/${id}/complete`, {
            api: 'auth-assistance',
            actor: 'user',
            method: 'POST',
            body: { userMessage },
          });
          assert.equal(denied.status, 403);
          assert.equal(h.authSignals, 0);
        }
        let arrivals = 0;
        let release!: () => void;
        const both = new Promise<void>((resolve) => {
          release = resolve;
        });
        h.beforeAuthCompletion = async () => {
          if (++arrivals === 2) release();
          await both;
        };
        const completed = await Promise.all(
          [0, 1].map(() =>
            h.request(f.userId, `/${id}/complete`, {
              api: 'auth-assistance',
              actor: 'user',
              method: 'POST',
            })
          )
        );
        completed.forEach((r) => assert.equal(r.status, 200));
        h.beforeAuthCompletion = undefined;
        assert.equal(h.authSignals, 1, 'Concurrent native completion signaled twice');
        assert.equal(h.authResumes, 1, 'Concurrent native completion resumed twice');
        const laterRetry = await h.request(f.userId, `/${id}/complete`, {
          api: 'auth-assistance',
          method: 'POST',
        });
        assert.equal(laterRetry.status, 200);
        assert.equal(laterRetry.data.alreadyCompleted, true);
        assert.equal(h.authSignals, 2, 'Actual current completed retry did not recover signal');
        assert.equal(h.authResumes, 2);
        const lease = await prisma.iPhoneLease.findUniqueOrThrow({ where: { id: f.leaseId } });
        assert.equal(lease.controlOwner, 'agent');
        assert.equal(lease.attentionRequestId, null);
        assert.equal(lease.actionCursor, 1);
        assert.ok(lease.leaseExpiresAt!.getTime() > Date.now() + 110000);
        const device = await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } });
        assert.equal(device.setupState, 'verifying');
        assert.equal(privacyState(device.privateInputEncrypted).active, false);
        assert.ok(privacyState(device.privateInputEncrypted).values.includes(canary));
        const retry = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: f.body,
        });
        assert.equal((retry.data.request as { id: string }).id, id);
        assert.ok((retry.data.request as { completedAt: string }).completedAt);
        assert.equal(
          (
            await h.request(f.userId, `/${id}/complete`, {
              api: 'auth-assistance',
              method: 'POST',
              body: { user_message: 'private completed retry' },
            })
          ).status,
          403
        );
        assert.equal(
          await prisma.message.count({ where: { agentId: f.agentId, role: 'USER' } }),
          0
        );
        assert.equal(await prisma.steelSessionAuth.count({ where: { userId: f.userId } }), 0);
        assert.deepEqual(
          await prisma.browserSession.findUniqueOrThrow({ where: { id: f.taskId } }),
          beforeBrowser
        );
        assert.equal(
          await prisma.browserProviderProfile.count({
            where: { contextId: beforeBrowser.contextId },
          }),
          0
        );
        assert.equal((await op(id)).status, 409, 'Completed attention still authorized input');
      }),
  ],
  [
    'native attention rejects in-flight reads and unknown input cannot complete or replay',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        const held = h.holdRead();
        const reading = h.request(f.userId, `/leases/${f.leaseId}/operations`, {
          method: 'POST',
          body: { operationId: randomUUID(), operation: 'screen.text', args: {} },
        });
        await held.entered;
        try {
          assert.equal(
            (
              await h.request(f.userId, '/', {
                api: 'auth-assistance',
                method: 'POST',
                body: { ...f.body, expectedCursor: 1 },
              })
            ).status,
            409
          );
        } finally {
          held.release();
          await reading;
        }
        const created = await h.request(f.userId, '/', {
          api: 'auth-assistance',
          method: 'POST',
          body: { ...f.body, expectedCursor: 1 },
        });
        assert.equal(created.status, 201);
        const id = (created.data.request as { id: string }).id;
        h.inputMode = 'unknown';
        const operationId = randomUUID();
        const input = () =>
          h.request(f.userId, `/leases/${f.leaseId}/operations`, {
            actor: 'user',
            method: 'POST',
            body: {
              operationId,
              operation: 'input.text',
              args: { s: 'synthetic-unknown-private' },
              attentionRequestId: id,
              expectedCursor: 1,
            },
          });
        assert.equal((await input()).data.operation?.status, 'UNKNOWN');
        assert.equal((await input()).data.operation?.status, 'UNKNOWN');
        assert.equal(h.physicalOperations.filter((call) => call.op === 'input.text').length, 1);
        assert.equal(
          (await h.request(f.userId, `/${id}/complete`, { api: 'auth-assistance', method: 'POST' }))
            .status,
          409
        );
        assert.equal(
          (await prisma.userAuthAssistanceRequest.findUniqueOrThrow({ where: { id } })).completedAt,
          null
        );
        assert.equal(h.authSignals, 0);
      }),
  ],
  [
    'native SMS source notification carries exact task and attention link using mock transport',
    () =>
      withPhone(async (h) => {
        const f = await fixture(h);
        await prisma.agent.update({
          where: { id: f.agentId },
          data: { source: 'SMS', isBenchmark: true },
        });
        const original = globalThis.fetch;
        globalThis.fetch = ((input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          assert.ok(
            ['127.0.0.1', 'localhost'].includes(url.hostname),
            'Native notification attempted live outbound transport'
          );
          return original(input, init);
        }) as typeof fetch;
        try {
          const created = await h.request(f.userId, '/', {
            api: 'auth-assistance',
            method: 'POST',
            body: f.body,
          });
          assert.equal(created.status, 201);
          const id = (created.data.request as { id: string }).id;
          const session = await prisma.smsSession.findUniqueOrThrow({
            where: { userId: f.userId },
          });
          const raw =
            typeof session.messages === 'string' ? JSON.parse(session.messages) : session.messages;
          const messages = JSON.stringify(raw);
          assert.ok(
            messages.includes(f.agentId) &&
              messages.includes(f.taskId) &&
              messages.includes(encodeURIComponent(id)),
            'Native lifecycle SMS lost exact agent/task/attention link'
          );
        } finally {
          globalThis.fetch = original;
        }
      }),
  ],
];
