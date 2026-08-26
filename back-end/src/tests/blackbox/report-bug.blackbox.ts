#!/usr/bin/env tsx
/**
 * Black-box HTTP gates for POST /api/agents/:id/report-bug.
 *
 * Happy-path Cursor launch is covered by unit tests with a mocked Cursor API.
 * This suite cements auth + validation surfaces against a live backend.
 */

import { config } from 'dotenv';
import { z } from 'zod';
config();

const BASE_URL = process.env.TEST_BASE_URL || `http://127.0.0.1:${process.env.CONDUCTOR_PORT || '3001'}`;
const API_KEY = process.env.BACKEND_API_KEY || '';
if (API_KEY === '') {
  throw new Error('BACKEND_API_KEY must be set (dotenv loads back-end/.env)');
}
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const FAKE_UUID = '00000000-0000-4000-8000-000000000099';

const ErrorResponse = z.object({ error: z.string() });

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let data: unknown;
  const ct = response.headers.get('content-type');
  if (ct?.includes('application/json')) {
    data = await response.json();
  } else {
    data = await response.text();
  }
  return { status: response.status, data };
}

function apiKeyHeaders(userId: string): Record<string, string> {
  return { 'X-API-Key': API_KEY, 'X-User-Id': userId };
}

function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

function assertSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${label} schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function createAnonymousUser(): Promise<string> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST', body: '{}' });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { user?: { id?: string } };
  if (typeof body.user?.id !== 'string') throw new Error('anonymous user missing id');
  return body.user.id;
}

async function createAgent(userId: string): Promise<string> {
  const res = await request(`${BASE_URL}/api/agents`, {
    method: 'POST',
    headers: apiKeyHeaders(userId),
    body: JSON.stringify({ goal: 'report-bug blackbox fixture' }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`create agent failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  const body = res.data as { agent_id?: string; agent?: { agent_id?: string; id?: string } };
  const id = body.agent_id ?? body.agent?.agent_id ?? body.agent?.id;
  if (typeof id !== 'string') throw new Error(`missing agent_id: ${JSON.stringify(res.data)}`);
  return id;
}

async function deleteAgent(agentId: string, userId: string): Promise<void> {
  await request(`${BASE_URL}/api/agents/${agentId}`, {
    method: 'DELETE',
    headers: apiKeyHeaders(userId),
  });
}

async function testNoAuth(): Promise<void> {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/report-bug`, {
    method: 'POST',
    body: JSON.stringify({ description: 'x' }),
  });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'no-auth');
}

async function testNonAdminForbidden(): Promise<void> {
  const userId = await createAnonymousUser();
  const agentId = await createAgent(userId);
  try {
    const res = await request(`${BASE_URL}/api/agents/${agentId}/report-bug`, {
      method: 'POST',
      headers: apiKeyHeaders(userId),
      body: JSON.stringify({ description: 'non-admin should not launch cursor agents' }),
    });
    assertStatus(res.status, 403, res.data);
    assertSchema(ErrorResponse, res.data, 'non-admin');
  } finally {
    await deleteAgent(agentId, userId);
  }
}

async function testEmptyDescription(): Promise<void> {
  const agentId = await createAgent(ANDY_USER_ID);
  try {
    const res = await request(`${BASE_URL}/api/agents/${agentId}/report-bug`, {
      method: 'POST',
      headers: apiKeyHeaders(ANDY_USER_ID),
      body: JSON.stringify({ description: '   ' }),
    });
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, 'empty-description');
  } finally {
    await deleteAgent(agentId, ANDY_USER_ID);
  }
}

async function testMissingAgent(): Promise<void> {
  const res = await request(`${BASE_URL}/api/agents/${FAKE_UUID}/report-bug`, {
    method: 'POST',
    headers: apiKeyHeaders(ANDY_USER_ID),
    body: JSON.stringify({ description: 'agent does not exist' }),
  });
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'missing-agent');
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

async function main(): Promise<void> {
  const health = await request(`${BASE_URL}/api/health`).catch(() => null);
  if (health === null || (health.status !== 200 && health.status !== 404)) {
    // /api/health may 404; try agents without auth as liveness
    const probe = await request(`${BASE_URL}/api/agents`).catch(() => null);
    if (probe === null) {
      console.error(`Backend not reachable at ${BASE_URL}`);
      process.exit(1);
    }
  }

  const results = await Promise.all([
    runTest('POST /report-bug -- no auth -> 401', testNoAuth),
    runTest('POST /report-bug -- non-admin -> 403', testNonAdminForbidden),
    runTest('POST /report-bug -- empty description -> 400', testEmptyDescription),
    runTest('POST /report-bug -- missing agent -> 404', testMissingAgent),
  ]);

  let failed = 0;
  for (const result of results) {
    if (result.passed) {
      console.log(`PASS ${result.name} (${result.duration}ms)`);
    } else {
      failed += 1;
      console.log(`FAIL ${result.name}: ${result.error}`);
    }
  }
  console.log(`RESULTS: ${results.length - failed}/${results.length} passed`);
  if (failed > 0) process.exit(1);
}

void main();
