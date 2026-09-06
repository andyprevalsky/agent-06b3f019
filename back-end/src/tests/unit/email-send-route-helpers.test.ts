#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Unit coverage for email send route helpers (validation + error mapping).
 */

import assert from 'node:assert';
import type { Response } from 'express';
import {
  GmailAccountNotFoundError,
  GmailAuthFailedError,
  GmailTokenExpiredError,
} from '../../domains/integrations/service.errors';
import {
  mapEmailSendError,
  requireFromEmailOrRespond,
  validateIdempotencyOrRespond,
} from '../../domains/integrations/routes.email';
import { GmailSendIdempotencyConflictError } from '../../domains/integrations/service.emailSendOnce';
import { ToolSideEffectAlreadyStartedError } from '../../providers/toolSideEffects';
import type { ToolSideEffect } from '@prisma/client';

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

function mockRes(): Response & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

async function main(): Promise<void> {
  await test('requireFromEmailOrRespond lists available accounts when connected', async () => {
    const res = mockRes();
    const value = await requireFromEmailOrRespond(res, 'user-1', null, {
      getAvailableGmailEmails: async () => ['connected@example.com'],
    });
    assert.strictEqual(value, null);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(JSON.stringify(res.body).includes('connected@example.com'));
  });

  await test('requireFromEmailOrRespond returns provided from_email', async () => {
    const res = mockRes();
    const value = await requireFromEmailOrRespond(res, 'user-1', 'me@x.com');
    assert.strictEqual(value, 'me@x.com');
    assert.strictEqual(res.statusCode, 200);
  });

  await test('requireFromEmailOrRespond reports gmail not connected when empty', async () => {
    const res = mockRes();
    const value = await requireFromEmailOrRespond(res, 'user-no-gmail-zzzz', '');
    assert.strictEqual(value, null);
    assert.strictEqual(res.statusCode, 400);
    assert.ok(JSON.stringify(res.body).toLowerCase().includes('gmail'));
  });

  await test('validateIdempotencyOrRespond allows missing key', () => {
    const res = mockRes();
    assert.strictEqual(validateIdempotencyOrRespond(res, undefined, undefined), true);
  });

  await test('validateIdempotencyOrRespond requires agent_id', () => {
    const res = mockRes();
    assert.strictEqual(validateIdempotencyOrRespond(res, 'call-1', undefined), false);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('validateIdempotencyOrRespond rejects invalid key charset', () => {
    const res = mockRes();
    assert.strictEqual(validateIdempotencyOrRespond(res, 'bad key!', 'agent-1'), false);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('validateIdempotencyOrRespond accepts valid key + agent', () => {
    const res = mockRes();
    assert.strictEqual(validateIdempotencyOrRespond(res, 'call_1-ok', 'agent-1'), true);
  });

  await test('mapEmailSendError maps known Gmail and idempotency errors', () => {
    const cases: Array<{ err: unknown; status: number }> = [
      { err: new GmailAccountNotFoundError('x@y.com', []), status: 400 },
      { err: new GmailTokenExpiredError(), status: 400 },
      { err: new GmailAuthFailedError(), status: 400 },
      { err: new GmailSendIdempotencyConflictError('conflict'), status: 409 },
      {
        err: new ToolSideEffectAlreadyStartedError({
          id: '1',
          operationKey: 'k',
          operationType: 'gmail.message',
          status: 'STARTED',
          request: null,
          response: null,
          externalId: null,
          error: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as ToolSideEffect),
        status: 409,
      },
    ];
    for (const c of cases) {
      const res = mockRes();
      const mapped = mapEmailSendError(res, c.err);
      assert.ok(mapped !== null);
      assert.strictEqual(res.statusCode, c.status);
    }
    const res = mockRes();
    assert.strictEqual(mapEmailSendError(res, new Error('other')), null);
  });

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
