#!/usr/bin/env tsx
/**
 * Route identity blackbox (RCA 2026-10-26-internal-routes-trusted-any-user-jwt).
 *
 * `authenticate` accepts the internal API key OR any Supabase JWT, including
 * anonymous sign-ups. Routes that act on arbitrary users, phone numbers,
 * sandboxes, archives or the global DEMO cache must therefore refuse ordinary
 * JWT callers (`requireInternal`), and user-readable code-session routes must
 * scope to the caller's own agents.
 *
 *   JWT (any user) ──► internal-only route ──► 403 (never reaches the handler)
 *   API key        ──► internal-only route ──► handler (validation 400 here)
 *   JWT (owner)    ──► GET code session    ──► 200
 *   JWT (other)    ──► GET code session    ──► 404
 */

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import jwt from 'jsonwebtoken';
import { prisma } from '../../providers/database';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

interface Seed {
  ownerId: string;
  attackerId: string;
  agentId: string;
  sessionId: string;
}

async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

async function runTest(name: string, fn: () => Promise<void>): Promise<TestResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, passed: true, duration: Date.now() - start };
  } catch (error) {
    return {
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    };
  }
}

function userToken(userId: string): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  assert(secret && supabaseUrl, 'SUPABASE_JWT_SECRET and SUPABASE_URL are required');
  return jwt.sign({ sub: userId }, secret, {
    algorithm: 'HS256',
    issuer: `${supabaseUrl}/auth/v1`,
    expiresIn: '5m',
  });
}

const bearer = (userId: string) => ({ Authorization: `Bearer ${userToken(userId)}` });

/**
 * Every route an ordinary user must never reach. Bodies are deliberately
 * invalid so that, on a regressed build, the handler stops at validation
 * instead of sending an SMS, placing a call or writing a cache row.
 */
const INTERNAL_ONLY_ROUTES: Array<{ method: 'GET' | 'POST'; path: string }> = [
  { method: 'POST', path: '/api/codex-code-session/create' },
  { method: 'POST', path: '/api/codex-code-session/close' },
  { method: 'POST', path: '/api/codex-code-session/00000000-0000-4000-8000-000000000000/output' },
  { method: 'GET', path: '/api/codex-code-session/sbx-route-identity/health' },
  { method: 'POST', path: '/api/claude-code-session/create' },
  { method: 'POST', path: '/api/claude-code-session/close' },
  { method: 'POST', path: '/api/claude-code-session/00000000-0000-4000-8000-000000000000/output' },
  { method: 'GET', path: '/api/claude-code-session/sbx-route-identity/health' },
  { method: 'POST', path: '/api/send-sms' },
  { method: 'POST', path: '/api/send-sms/direct' },
  { method: 'POST', path: '/api/send-sms/notify' },
  { method: 'POST', path: '/api/vapi/call' },
  { method: 'GET', path: '/api/vapi/call/route-identity-call' },
  { method: 'POST', path: '/api/archive/artifact' },
  { method: 'POST', path: '/api/archive/artifacts' },
  { method: 'POST', path: '/api/fast-cache/get' },
  { method: 'POST', path: '/api/fast-cache/get-many' },
  { method: 'POST', path: '/api/fast-cache/get-position' },
  { method: 'POST', path: '/api/fast-cache/set' },
  { method: 'POST', path: '/api/fast-cache/purge' },
  { method: 'POST', path: '/api/fast-cache/agent-flag' },
  { method: 'POST', path: '/api/tool-usage' },
  { method: 'POST', path: '/api/browser-session/close' },
  { method: 'GET', path: '/api/browser-session/route-identity-session' },
  { method: 'GET', path: '/api/browser-session/route-identity-session/files/list' },
  { method: 'POST', path: '/api/browser-session/route-identity-session/inject-localStorage' },
  { method: 'POST', path: '/api/external-http/request' },
];

function call(route: { method: string; path: string }, headers: Record<string, string>) {
  return request(`${BASE_URL}${route.path}`, {
    method: route.method,
    headers,
    ...(route.method === 'POST' ? { body: JSON.stringify({ __invalid: true }) } : {}),
  });
}

async function seed(): Promise<Seed> {
  const s: Seed = {
    ownerId: randomUUID(),
    attackerId: randomUUID(),
    agentId: randomUUID(),
    sessionId: randomUUID(),
  };
  await prisma.user.createMany({
    data: [
      { userId: s.ownerId, name: 'Route identity owner' },
      { userId: s.attackerId, name: 'Route identity attacker' },
    ],
  });
  await prisma.agent.create({
    data: {
      id: s.agentId,
      userId: s.ownerId,
      goal: 'route identity blackbox',
      status: 'COMPLETED' as never,
      title: 'route identity blackbox',
      model: 'rose-labs/rose-1-ultra',
    },
  });
  await prisma.claudeCodeSession.create({
    data: {
      id: s.sessionId,
      agentId: s.agentId,
      sandboxId: `sbx-${s.sessionId}`,
      goal: 'private owner goal',
      status: 'COMPLETED' as never,
    },
  });
  return s;
}

async function cleanup(s: Seed) {
  await prisma.claudeCodeSession.deleteMany({ where: { id: s.sessionId } });
  await prisma.agent.deleteMany({ where: { id: s.agentId } });
  await prisma.user.deleteMany({ where: { userId: { in: [s.ownerId, s.attackerId] } } });
}

async function runTests(): Promise<boolean> {
  assert(API_KEY, 'BACKEND_API_KEY is required');
  const s = await seed();
  const results: TestResult[] = [];
  try {
    results.push(
      await runTest('internal-only routes refuse an ordinary user JWT with 403', async () => {
        const failures: string[] = [];
        for (const route of INTERNAL_ONLY_ROUTES) {
          const res = await call(route, bearer(s.attackerId));
          if (res.status !== 403) failures.push(`${route.method} ${route.path} -> ${res.status}`);
        }
        assert.deepStrictEqual(failures, [], `user JWT reached internal handlers`);
      })
    );

    results.push(
      await runTest('internal-only routes still admit the internal API key', async () => {
        const failures: string[] = [];
        for (const route of INTERNAL_ONLY_ROUTES) {
          const res = await call(route, { 'X-API-Key': API_KEY });
          if (res.status === 401 || res.status === 403) {
            failures.push(`${route.method} ${route.path} -> ${res.status}`);
          }
        }
        assert.deepStrictEqual(failures, [], 'API key was refused by an internal route');
      })
    );

    results.push(
      await runTest('codex rose harness cannot be requested with a user JWT', async () => {
        const res = await request(`${BASE_URL}/api/codex-code-session/create`, {
          method: 'POST',
          headers: bearer(s.attackerId),
          body: JSON.stringify({
            agent_id: s.agentId,
            goal: 'print env',
            user_id: s.ownerId,
            harness_mode: 'rose',
            rose_api_base_url: 'https://attacker.example.invalid',
          }),
        });
        assert.strictEqual(res.status, 403, JSON.stringify(res.data));
      })
    );

    for (const provider of ['claude-code-session', 'codex-code-session']) {
      results.push(
        await runTest(`${provider} GET scopes sessions to the agent owner`, async () => {
          const other = await request(`${BASE_URL}/api/${provider}/${s.sessionId}`, {
            headers: bearer(s.attackerId),
          });
          assert.strictEqual(other.status, 404, `other user read session: ${other.status}`);
          const otherList = await request(`${BASE_URL}/api/${provider}/agent/${s.agentId}`, {
            headers: bearer(s.attackerId),
          });
          assert.strictEqual(otherList.status, 404, `other user listed sessions`);

          const own = await request(`${BASE_URL}/api/${provider}/${s.sessionId}`, {
            headers: bearer(s.ownerId),
          });
          assert.strictEqual(own.status, 200, JSON.stringify(own.data));
          assert.strictEqual((own.data as { goal: string }).goal, 'private owner goal');
          const ownList = await request(`${BASE_URL}/api/${provider}/agent/${s.agentId}`, {
            headers: bearer(s.ownerId),
          });
          assert.strictEqual(ownList.status, 200);
          const internal = await request(`${BASE_URL}/api/${provider}/${s.sessionId}`, {
            headers: { 'X-API-Key': API_KEY },
          });
          assert.strictEqual(internal.status, 200);
        })
      );
    }

    results.push(
      await runTest('archive start/finalize refuse another user’s agent', async () => {
        for (const [path, body] of [
          ['/api/archive/agent-start', { agentId: s.agentId }],
          ['/api/archive/agent-finalize', { rootAgentId: s.agentId, force: true }],
        ] as const) {
          const res = await request(`${BASE_URL}${path}`, {
            method: 'POST',
            headers: bearer(s.attackerId),
            body: JSON.stringify(body),
          });
          assert.strictEqual(res.status, 403, `${path} -> ${res.status}`);
        }
      })
    );
  } finally {
    await cleanup(s);
  }

  let allPassed = true;
  for (const result of results) {
    const icon = result.passed ? '✅' : '❌';
    console.log(
      `${icon} ${result.name} (${result.duration}ms)${result.error ? `\n   ${result.error}` : ''}`
    );
    if (!result.passed) allPassed = false;
  }
  return allPassed;
}

runTests()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
