#!/usr/bin/env tsx
/**
 * Black-box: GET /api/agent-queue-pointer is internal-key-only and returns the
 * live routing pointer used by cooperative generation handoff.
 */
import { config } from 'dotenv';

config();

const BASE =
  process.env.TEST_BASE_URL ||
  process.env.BACKEND_URL ||
  process.env.BACKEND_API_URL ||
  `http://127.0.0.1:${process.env.PORT || '3001'}`;
const API_KEY = process.env.BACKEND_API_KEY;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

async function main(): Promise<void> {
  assert(API_KEY, 'BACKEND_API_KEY required');

  const unauth = await fetch(`${BASE.replace(/\/$/, '')}/api/agent-queue-pointer`);
  assert(
    unauth.status === 401 || unauth.status === 403,
    `unauthenticated pointer read must be rejected (got ${unauth.status})`
  );

  const authed = await fetch(`${BASE.replace(/\/$/, '')}/api/agent-queue-pointer`, {
    headers: { 'X-API-Key': API_KEY },
  });
  assert(authed.status === 200, `internal pointer read must succeed (got ${authed.status})`);
  const body = (await authed.json()) as { taskQueue?: string; surfaceHash?: string | null };
  assert(typeof body.taskQueue === 'string' && body.taskQueue.length > 0, 'taskQueue required');
  assert('surfaceHash' in body, 'surfaceHash field required');

  process.stdout.write('PASS agent-queue-pointer-route: internal auth + payload\n');
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
