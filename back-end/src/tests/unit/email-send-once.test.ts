#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit tests for idempotent Gmail send (message_person email channel).
 * Uses real ToolSideEffect rows on the local DB; never calls live Gmail.
 */

import assert from 'node:assert';
import { createHash } from 'node:crypto';
import { prisma } from '../../providers/database';
import { ToolSideEffectAlreadyStartedError } from '../../providers/toolSideEffects';
import {
  GmailSendIdempotencyConflictError,
  sendEmailOnce,
} from '../../domains/integrations/service.emailSendOnce';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

function operationKey(userId: string, agentId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${agentId}\0${idempotencyKey}`)
    .digest('hex');
  return `gmail.message:${digest}`;
}

async function main(): Promise<void> {
  const prefix = `unit-email-send-${Date.now()}`;
  const userId = `${prefix}-user`;
  const agentId = `${prefix}-agent`;
  const keys: string[] = [];

  const cleanup = async () => {
    for (const key of keys) {
      await prisma.toolSideEffect.deleteMany({ where: { operationKey: key } });
    }
  };

  try {
    await test('sendEmailOnce returns cached SUCCEEDED response on retry', async () => {
      const idempotencyKey = `${prefix}-cached`;
      const key = operationKey(userId, agentId, idempotencyKey);
      keys.push(key);
      const request = {
        user_id: userId,
        agent_id: agentId,
        idempotency_key: idempotencyKey,
        to: 'a@b.com',
        from_email: 'me@x.com',
        subject: 'Hi',
        body: 'Body',
      };
      await prisma.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: 'gmail.message',
          request,
          status: 'SUCCEEDED',
          externalId: 'gmail-cached-1',
          response: { id: 'gmail-cached-1', threadId: 'thread-cached-1' },
        },
      });

      const result = await sendEmailOnce(userId, {
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Body',
        fromEmail: 'me@x.com',
        agentId,
        idempotencyKey,
      });
      assert.deepStrictEqual(result, { id: 'gmail-cached-1', threadId: 'thread-cached-1' });
    });

    await test('sendEmailOnce rejects idempotency payload conflicts', async () => {
      const idempotencyKey = `${prefix}-conflict`;
      const key = operationKey(userId, agentId, idempotencyKey);
      keys.push(key);
      await prisma.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: 'gmail.message',
          request: {
            user_id: userId,
            agent_id: agentId,
            idempotency_key: idempotencyKey,
            to: 'other@b.com',
            from_email: 'me@x.com',
            subject: 'Hi',
            body: 'Body',
          },
          status: 'SUCCEEDED',
          externalId: 'gmail-other',
          response: { id: 'gmail-other', threadId: 'thread-other' },
        },
      });

      await assert.rejects(
        () =>
          sendEmailOnce(userId, {
            to: 'a@b.com',
            subject: 'Hi',
            body: 'Body',
            fromEmail: 'me@x.com',
            agentId,
            idempotencyKey,
          }),
        GmailSendIdempotencyConflictError
      );
    });

    await test('sendEmailOnce refuses in-flight STARTED claims without external id', async () => {
      const idempotencyKey = `${prefix}-started`;
      const key = operationKey(userId, agentId, idempotencyKey);
      keys.push(key);
      const request = {
        user_id: userId,
        agent_id: agentId,
        idempotency_key: idempotencyKey,
        to: 'a@b.com',
        from_email: 'me@x.com',
        subject: 'Hi',
        body: 'Body',
      };
      await prisma.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: 'gmail.message',
          request,
          status: 'STARTED',
        },
      });

      await assert.rejects(
        () =>
          sendEmailOnce(userId, {
            to: 'a@b.com',
            subject: 'Hi',
            body: 'Body',
            fromEmail: 'me@x.com',
            agentId,
            idempotencyKey,
          }),
        ToolSideEffectAlreadyStartedError
      );
    });

    await test('sendEmailOnce refuses SUCCEEDED records with incomplete response payload', async () => {
      const idempotencyKey = `${prefix}-bad-response`;
      const key = operationKey(userId, agentId, idempotencyKey);
      keys.push(key);
      const request = {
        user_id: userId,
        agent_id: agentId,
        idempotency_key: idempotencyKey,
        to: 'a@b.com',
        from_email: 'me@x.com',
        subject: 'Hi',
        body: 'Body',
        cc: 'cc@x.com',
      };
      await prisma.toolSideEffect.create({
        data: {
          operationKey: key,
          operationType: 'gmail.message',
          request,
          status: 'SUCCEEDED',
          externalId: 'gmail-incomplete',
          response: { id: 'gmail-incomplete' },
        },
      });

      await assert.rejects(
        () =>
          sendEmailOnce(userId, {
            to: 'a@b.com',
            subject: 'Hi',
            body: 'Body',
            fromEmail: 'me@x.com',
            agentId,
            idempotencyKey,
            cc: 'cc@x.com',
          }),
        ToolSideEffectAlreadyStartedError
      );
    });

    await test('sendEmailOnce marks FAILED when Gmail credential is missing', async () => {
      const idempotencyKey = `${prefix}-fail`;
      const key = operationKey(userId, agentId, idempotencyKey);
      keys.push(key);

      await assert.rejects(() =>
        sendEmailOnce(userId, {
          to: 'a@b.com',
          subject: 'Hi',
          body: 'Body',
          fromEmail: 'missing-sender@example.com',
          agentId,
          idempotencyKey,
        })
      );

      const record = await prisma.toolSideEffect.findUniqueOrThrow({ where: { operationKey: key } });
      assert.strictEqual(record.status, 'FAILED');
      assert.ok(typeof record.error === 'string' && record.error.length > 0);
    });
  } finally {
    await cleanup();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
