#!/usr/bin/env tsx
/**
 * Black-box HTTP gates for POST /api/agents/:id/report-bug, its
 * POST /api/agents/:id/report-bug/screenshots image upload and the root agent
 * report_bug tool's POST /api/agents/:id/report-bug/by-agent.
 *
 * Happy-path boxes.dev launch is covered by unit tests with a mocked boxes.dev API.
 * This suite cements auth + validation surfaces against a live backend.
 */

import { config } from 'dotenv';
import { z } from 'zod';
import { retryWithBackoff } from '../../providers/retry';
config();

const BASE_URL =
  process.env.TEST_BASE_URL || `http://127.0.0.1:${process.env.CONDUCTOR_PORT || '3001'}`;
const API_KEY = process.env.BACKEND_API_KEY || '';
if (API_KEY === '') {
  throw new Error('BACKEND_API_KEY must be set (dotenv loads back-end/.env)');
}
const ANDY_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const FAKE_UUID = '00000000-0000-4000-8000-000000000099';

const ErrorResponse = z.object({ error: z.string() });
const ScreenshotResponse = z.object({
  success: z.literal(true),
  name: z.string(),
  url: z.string().url(),
  expires_in: z.literal(604_800),
});
/** 1x1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

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

async function createAnonymousSession(): Promise<{ userId: string; accessToken: string }> {
  const res = await request(`${BASE_URL}/api/auth/anonymous`, { method: 'POST', body: '{}' });
  assertStatus(res.status, 200, res.data);
  const body = res.data as { user?: { id?: string }; session?: { access_token?: string } };
  if (typeof body.user?.id !== 'string') throw new Error('anonymous user missing id');
  if (typeof body.session?.access_token !== 'string') {
    throw new Error('anonymous session missing access_token');
  }
  return { userId: body.user.id, accessToken: body.session.access_token };
}

async function createAnonymousUser(): Promise<string> {
  return (await createAnonymousSession()).userId;
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
      body: JSON.stringify({ description: 'non-admin should not launch bug report agents' }),
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

/** A fresh backend answers 503 + Retry-After while the Hub archive index warms. */
class HubIndexWarmingError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Hub archive index warming; Retry-After ${retryAfterMs}ms`);
  }
}

async function testMissingAgent(): Promise<void> {
  // Honor the documented 503 + Retry-After warming contract, then require the real 404.
  const res = await retryWithBackoff(
    async () => {
      const response = await fetch(`${BASE_URL}/api/agents/${FAKE_UUID}/report-bug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiKeyHeaders(ANDY_USER_ID) },
        body: JSON.stringify({ description: 'agent does not exist' }),
      });
      const data: unknown = await response.json();
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      if (response.status === 503 && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        throw new HubIndexWarmingError(retryAfterSeconds * 1000);
      }
      return { status: response.status, data };
    },
    {
      maxRetries: 12,
      isRetryable: (error) => error instanceof HubIndexWarmingError,
      getBackoffDelayMs: (error) => (error as HubIndexWarmingError).retryAfterMs,
      component: 'ReportBugBlackbox',
    }
  );
  assertStatus(res.status, 404, res.data);
  assertSchema(ErrorResponse, res.data, 'missing-agent');
}

function postByAgent(
  agentId: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; data: unknown }> {
  return request(`${BASE_URL}/api/agents/${agentId}/report-bug/by-agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function testByAgentNoAuth(): Promise<void> {
  const res = await postByAgent(FAKE_UUID, {}, { description: 'x' });
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'by-agent-no-auth');
}

/** A user session cannot file as the agent, even on its own agent. */
async function testByAgentRequiresInternalKey(): Promise<void> {
  const session = await createAnonymousSession();
  const agentId = await createAgent(session.userId);
  try {
    const res = await postByAgent(
      agentId,
      { Authorization: `Bearer ${session.accessToken}` },
      { description: 'only the worker files agent bug reports' }
    );
    assertStatus(res.status, 403, res.data);
    assertSchema(ErrorResponse, res.data, 'by-agent-user-session');
  } finally {
    await deleteAgent(agentId, session.userId);
  }
}

async function testByAgentNonAdminForbidden(): Promise<void> {
  const userId = await createAnonymousUser();
  const agentId = await createAgent(userId);
  try {
    const res = await postByAgent(agentId, apiKeyHeaders(userId), {
      description: 'non-admin agents do not launch bug report threads',
    });
    assertStatus(res.status, 403, res.data);
    assertSchema(ErrorResponse, res.data, 'by-agent-non-admin');
  } finally {
    await deleteAgent(agentId, userId);
  }
}

const RecordedReport = z.object({
  success: z.literal(true),
  mode: z.literal('recorded'),
  name: z.string(),
  url: z.null(),
  run_id: z.null(),
  already_reported: z.boolean(),
});

const SelfReportView = z.object({
  agent_id: z.string(),
  root_agent_id: z.string(),
  report: z
    .object({
      status: z.literal('recorded'),
      title: z.string(),
      description: z.string(),
      boxes_run_id: z.null(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .nullable(),
});

/**
 * The test backend is not production: the report is saved for /rca, nothing is
 * launched, and the internal read returns it.
 */
async function testByAgentSavesOutsideProduction(): Promise<void> {
  const agentId = await createAgent(ANDY_USER_ID);
  try {
    const before = await request(`${BASE_URL}/api/agents/${agentId}/report-bug/by-agent`, {
      headers: apiKeyHeaders(ANDY_USER_ID),
    });
    assertStatus(before.status, 200, before.data);
    if (assertSchema(SelfReportView, before.data, 'self-report-before').report !== null) {
      throw new Error('a fresh agent must have no self-report');
    }
    const res = await postByAgent(agentId, apiKeyHeaders(ANDY_USER_ID), {
      description: 'grep returned HTTP 500 twice for a valid pattern',
    });
    assertStatus(res.status, 201, res.data);
    const body = assertSchema(RecordedReport, res.data, 'by-agent-recorded');
    if (body.already_reported || !body.name.startsWith('--ai-- ')) {
      throw new Error(`unexpected recorded report: ${JSON.stringify(body)}`);
    }
    const again = await postByAgent(agentId, apiKeyHeaders(ANDY_USER_ID), {
      description: 'a second problem',
      record_only: true,
    });
    assertStatus(again.status, 201, again.data);
    if (!assertSchema(RecordedReport, again.data, 'by-agent-again').already_reported) {
      throw new Error('a run saves only its first report');
    }
    const view = await request(`${BASE_URL}/api/agents/${agentId}/report-bug/by-agent`, {
      headers: apiKeyHeaders(ANDY_USER_ID),
    });
    assertStatus(view.status, 200, view.data);
    const report = assertSchema(SelfReportView, view.data, 'self-report-after').report;
    if (report?.description !== 'grep returned HTTP 500 twice for a valid pattern') {
      throw new Error(`self-report read returned ${JSON.stringify(view.data)}`);
    }
  } finally {
    await deleteAgent(agentId, ANDY_USER_ID);
  }
}

/** /rca reads go through the internal key; a user session is refused. */
async function testByAgentReadRequiresInternalKey(): Promise<void> {
  const session = await createAnonymousSession();
  const agentId = await createAgent(session.userId);
  try {
    const res = await request(`${BASE_URL}/api/agents/${agentId}/report-bug/by-agent`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    assertStatus(res.status, 403, res.data);
    assertSchema(ErrorResponse, res.data, 'self-report-read-user-session');
  } finally {
    await deleteAgent(agentId, session.userId);
  }
}

async function postScreenshot(
  agentId: string,
  headers: Record<string, string>,
  file: { bytes: Buffer; name: string; type: string }
): Promise<{ status: number; data: unknown }> {
  const form = new FormData();
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  const response = await fetch(`${BASE_URL}/api/agents/${agentId}/report-bug/screenshots`, {
    method: 'POST',
    headers,
    body: form,
  });
  return { status: response.status, data: await response.json() };
}

async function testScreenshotNoAuth(): Promise<void> {
  const res = await postScreenshot(
    FAKE_UUID,
    {},
    { bytes: PNG_1X1, name: 'a.png', type: 'image/png' }
  );
  assertStatus(res.status, 401, res.data);
  assertSchema(ErrorResponse, res.data, 'screenshot-no-auth');
}

async function testScreenshotNonAdminForbidden(): Promise<void> {
  const userId = await createAnonymousUser();
  const agentId = await createAgent(userId);
  try {
    const res = await postScreenshot(agentId, apiKeyHeaders(userId), {
      bytes: PNG_1X1,
      name: 'a.png',
      type: 'image/png',
    });
    assertStatus(res.status, 403, res.data);
    assertSchema(ErrorResponse, res.data, 'screenshot-non-admin');
  } finally {
    await deleteAgent(agentId, userId);
  }
}

async function testScreenshotRejectsNonImage(): Promise<void> {
  const agentId = await createAgent(ANDY_USER_ID);
  try {
    const res = await postScreenshot(agentId, apiKeyHeaders(ANDY_USER_ID), {
      bytes: Buffer.from('<!doctype html><html></html>'),
      name: 'not-really.png',
      type: 'image/png',
    });
    assertStatus(res.status, 400, res.data);
    assertSchema(ErrorResponse, res.data, 'screenshot-non-image');
  } finally {
    await deleteAgent(agentId, ANDY_USER_ID);
  }
}

/** The signed URL must serve the uploaded bytes to whoever reads the description. */
async function testScreenshotSignedUrlServesImage(): Promise<void> {
  const agentId = await createAgent(ANDY_USER_ID);
  try {
    const res = await postScreenshot(agentId, apiKeyHeaders(ANDY_USER_ID), {
      bytes: PNG_1X1,
      name: 'live view.png',
      type: 'image/png',
    });
    assertStatus(res.status, 201, res.data);
    const body = assertSchema(ScreenshotResponse, res.data, 'screenshot-upload');
    const image = await fetch(body.url);
    if (image.status !== 200) throw new Error(`signed URL returned ${image.status}`);
    const served = Buffer.from(await image.arrayBuffer());
    if (!served.equals(PNG_1X1)) throw new Error('signed URL served different bytes');
  } finally {
    await deleteAgent(agentId, ANDY_USER_ID);
  }
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
    runTest('POST /report-bug/by-agent -- no auth -> 401', testByAgentNoAuth),
    runTest('POST /report-bug/by-agent -- user session -> 403', testByAgentRequiresInternalKey),
    runTest('POST /report-bug/by-agent -- non-admin owner -> 403', testByAgentNonAdminForbidden),
    runTest(
      'POST+GET /report-bug/by-agent -- non-production backend saves, read returns it',
      testByAgentSavesOutsideProduction
    ),
    runTest('GET /report-bug/by-agent -- user session -> 403', testByAgentReadRequiresInternalKey),
    runTest('POST /report-bug/screenshots -- no auth -> 401', testScreenshotNoAuth),
    runTest('POST /report-bug/screenshots -- non-admin -> 403', testScreenshotNonAdminForbidden),
    runTest('POST /report-bug/screenshots -- non-image -> 400', testScreenshotRejectsNonImage),
    runTest(
      'POST /report-bug/screenshots -- signed URL serves the image',
      testScreenshotSignedUrlServesImage
    ),
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
