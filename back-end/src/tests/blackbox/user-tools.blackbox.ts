#!/usr/bin/env tsx
/**
 * Black-box tests for user tools (agents domains/user_tools) on the backend.
 *
 * Domain surface (internal: X-API-Key + X-User-Id, mounted on /api/user-ui):
 *   POST /api/user-ui/tools/run               run a handler in the caller's own code session
 *   POST /api/user-ui/tool-calls/claim        claim a side-effecting call (ToolSideEffect)
 *   POST /api/user-ui/tool-calls/complete     store its run record (first write wins)
 *   POST /api/user-ui/tool-calls/release      re-open a claim whose handler never started
 *
 * Invariants (cases in user-tools.cases.ts):
 *   - a run executes in the caller's "user-tools" CodeSession HOME, releases its
 *     lease, and the next call resumes the same session
 *   - another user's session or version is never used (404, no session resolved)
 *   - the per-call handler timeout comes back as a structured run record
 *   - a side-effecting call retried after a lost completion runs once; the
 *     stored record is replayed; first write wins; a different call under the
 *     same key is a 409 conflict; user JWTs cannot reach the internal routes
 *   - concurrent duplicate claims: exactly one wins; a released claim reopens
 *   - the E2B path resumes the session's paused sandbox (fake Sandbox.connect)
 *   - the local session sandbox is refused in production
 *
 * Usage: bash scripts/run-blackbox-tests.sh user-tools
 */
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { userUiToolCases } from './user-tools.cases';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

interface Session {
  token: string;
  userId: string;
}

async function anonymousSession(): Promise<Session> {
  const response = await fetch(`${BASE_URL}/api/auth/anonymous`, { method: 'POST' });
  if (response.status !== 200) throw new Error(`anonymous session: ${response.status}`);
  const data = (await response.json()) as {
    session: { access_token: string };
    user: { id: string };
  };
  return { token: data.session.access_token, userId: data.user.id };
}

async function main(): Promise<void> {
  const userA = await anonymousSession();
  const userB = await anonymousSession();
  const tests = userUiToolCases({
    baseUrl: BASE_URL,
    apiKey: process.env.BACKEND_API_KEY || '',
    userA: () => userA,
    userB: () => userB,
    newUser: anonymousSession,
  });
  let failed = 0;
  for (const test of tests) {
    const start = Date.now();
    try {
      await test.fn();
      console.log(`  PASS  ${test.name} (${Date.now() - start}ms)`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${test.name} -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
