#!/usr/bin/env tsx
/**
 * Black-box tests for the unauthenticated health surfaces.
 *
 * Covers:
 *   GET /health/deep — 200 while the real test database is reachable.
 *   GET /health/deep — 503 with a generic body when the database check fails.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createDeepHealthHandler } from '../../providers/deepHealth';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const FIXED_TIME = new Date('2026-07-20T12:00:00.000Z');

async function testLiveDatabaseHealth(): Promise<void> {
  const response = await fetch(`${BASE_URL}/health/deep`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'up');
  assert.ok(!Number.isNaN(Date.parse(String(body.timestamp))), 'timestamp must be ISO-8601');
}

async function testDatabaseFailureIsGeneric(): Promise<void> {
  const app = express();
  const observedErrors: unknown[] = [];
  app.get(
    '/health/deep',
    createDeepHealthHandler({
      checkDatabase: async () => {
        throw new Error('postgres://internal-host.example/private');
      },
      now: () => FIXED_TIME,
      onError: (error) => observedErrors.push(error),
    })
  );

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/health/deep`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, {
      status: 'error',
      db: 'down',
      timestamp: FIXED_TIME.toISOString(),
    });
    assert.equal(JSON.stringify(body).includes('internal-host'), false);
    assert.equal(observedErrors.length, 1, 'the detailed error must remain server-side');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function main(): Promise<void> {
  await testLiveDatabaseHealth();
  console.log('  PASS  deep health reports the live database as up');
  await testDatabaseFailureIsGeneric();
  console.log('  PASS  deep health returns a generic 503 when the database check fails');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
