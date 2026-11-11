/** Actual authenticated routes and persistence; only outbound SMS transport is synthetic. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { ineligiblePhoneFixtureNumber } from './phone-fixture-users';
import type { Case } from './iphone-control.cases';

export const accessRequestCases: Case[] = [
  [
    'ineligible accounts persist access requests and notify the admin exactly once across concurrent retries',
    async (h) => {
      const f = await h.fixture();
      await prisma.user.update({
        where: { userId: f.userId },
        data: {
          name: 'Requesting Person',
          email: 'requester@example.invalid',
          phone: ineligiblePhoneFixtureNumber(),
        },
      });
      // No bound device: access-request persistence cannot depend on one existing.
      await prisma.iPhoneDevice.delete({ where: { id: f.deviceId } });
      const sends: { phone: string; body: string }[] = [];
      h.accessRequestSms = async (phone, body) => {
        sends.push({ phone, body });
        return { success: true, messageSid: 'synthetic-request-sms' };
      };
      const initial = await h.request(f.userId, '/connection', { actor: 'user' });
      assert.equal(initial.data.enabled, false);
      assert.equal(initial.data.accessRequested, false);
      const request = () =>
        h.request(f.userId, '/request-access', {
          actor: 'user',
          method: 'POST',
          body: {},
        });
      const responses = await Promise.all([request(), request(), request()]);
      for (const response of responses) {
        assert.equal(response.status, 200);
        assert.equal(response.data.accessRequested, true);
        assert.equal(response.data.enabled, false);
      }
      assert.equal(sends.length, 1);
      assert.equal(sends[0].phone, '+19729777432');
      assert.match(sends[0].body, /Requesting Person.*requester@example.invalid.*wants iPhone/);
      assert.ok(sends[0].body.includes(f.userId));
      const row = await prisma.integration.findUniqueOrThrow({
        where: {
          userId_name_accountId: { userId: f.userId, name: 'iphone', accountId: '' },
        },
      });
      assert.equal((row.config as { smsState: string }).smsState, 'sent');
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.accessRequested,
        true
      );
      assert.equal((await request()).status, 200);
      assert.equal(sends.length, 1);
      assert.equal(await prisma.iPhoneDevice.count({ where: { userId: f.userId } }), 0);
      assert.equal(
        (
          await h.request(f.userId, '/connect', {
            actor: 'user',
            method: 'POST',
            body: { requestKey: randomUUID(), expectedRevision: 0 },
          })
        ).status,
        403
      );
      const foreign = await h.fixture();
      assert.equal(
        (await h.request(foreign.userId, '/connection', { actor: 'user' })).data.accessRequested,
        false
      );
    },
  ],
  [
    'access requests reject forged account scope and internal or unauthenticated callers',
    async (h) => {
      const f = await h.fixture();
      const noAuth = await fetch(`${h.base}/api/iphone/request-access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(noAuth.status, 401);
      assert.equal(
        (await h.request(f.userId, '/request-access', { method: 'POST', body: {} })).status,
        403
      );
      assert.equal(
        (
          await h.request(f.userId, '/request-access', {
            actor: 'user',
            method: 'POST',
            body: { userId: randomUUID() },
          })
        ).status,
        400
      );
      assert.equal(
        await prisma.integration.count({ where: { userId: f.userId, name: 'iphone' } }),
        0
      );
    },
  ],
  [
    'failed SMS delivery retains the access request and a retry sends once without enabling access',
    async (h) => {
      const f = await h.fixture();
      await prisma.iPhoneDevice.update({ where: { id: f.deviceId }, data: { enabled: false } });
      let sends = 0;
      h.accessRequestSms = async () => {
        sends++;
        return sends === 1
          ? { success: false, error: 'synthetic unavailable' }
          : { success: true, messageSid: 'retry' };
      };
      const request = () =>
        h.request(f.userId, '/request-access', { actor: 'user', method: 'POST', body: {} });
      assert.equal((await request()).status, 503);
      assert.equal(
        (await h.request(f.userId, '/connection', { actor: 'user' })).data.accessRequested,
        true
      );
      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 200);
      assert.equal(sends, 2);
      assert.equal(
        (await prisma.iPhoneDevice.findUniqueOrThrow({ where: { id: f.deviceId } })).enabled,
        false
      );
    },
  ],
  [
    'already enabled account retains Connect and does not create a request or send SMS',
    async (h) => {
      const f = await h.fixture();
      let sends = 0;
      h.accessRequestSms = async () => {
        sends++;
        return { success: true };
      };
      const response = await h.request(f.userId, '/request-access', {
        actor: 'user',
        method: 'POST',
        body: {},
      });
      assert.equal(response.status, 200);
      assert.equal(response.data.enabled, true);
      assert.equal(response.data.accessRequested, false);
      assert.equal(sends, 0);
      assert.equal(
        await prisma.integration.count({ where: { userId: f.userId, name: 'iphone' } }),
        0
      );
    },
  ],
];
