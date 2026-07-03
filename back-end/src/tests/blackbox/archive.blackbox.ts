#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  collectFixture,
  restoreFixture,
  type ScopedDbFixture,
} from '../../domains/archive/fixture';
import {
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from '../../providers/traceArchive';

config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID = process.env.BLACKBOX_TEST_RUN_ID || `${Date.now()}-${randomUUID().slice(0, 8)}`;

interface SeededRun {
  userId: string;
  otherUserId: string;
  rootAgentId: string;
  childAgentId: string;
  toolId: string;
  messageId: string;
  staleMessageId: string;
  personId: string;
  otherPersonId: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
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

function ids(rows: unknown[] | undefined): string[] {
  return (rows ?? [])
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString() : nested
    )
  ) as T;
}

async function seedRun(): Promise<SeededRun> {
  const userId = `archive-user-${RUN_ID}-${randomUUID()}`;
  const otherUserId = `archive-other-${RUN_ID}-${randomUUID()}`;
  const rootAgentId = randomUUID();
  const childAgentId = randomUUID();
  const toolId = randomUUID();
  const messageId = randomUUID();
  const staleMessageId = randomUUID();
  const personId = randomUUID();
  const otherPersonId = randomUUID();
  await prisma.user.createMany({
    data: [
      { userId, name: 'Archive Fixture User' },
      { userId: otherUserId, name: 'Unrelated User' },
    ],
  });
  await prisma.tool.create({
    data: { id: toolId, name: `archive-tool-${RUN_ID}-${toolId}`, description: 'fixture tool' },
  });
  await prisma.agent.createMany({
    data: [
      {
        id: rootAgentId,
        userId,
        goal: 'archive root goal',
        model: 'rose-labs/rose-1-lite',
        status: 'COMPLETED',
        busId: rootAgentId,
      },
      {
        id: childAgentId,
        userId,
        goal: 'archive child goal',
        model: 'rose-labs/rose-1-lite',
        status: 'COMPLETED',
        parentAgentId: rootAgentId,
        busId: rootAgentId,
        depth: 1,
      },
    ],
  });
  await prisma.agentTool.create({ data: { agentId: rootAgentId, toolId } });
  await prisma.verifier.create({ data: { agentId: rootAgentId, type: 'FLOAT_LLM_JUDGE' } });
  await prisma.message.create({
    data: { id: messageId, agentId: rootAgentId, text: 'fixture message', role: 'USER' },
  });
  await prisma.toolUsage.create({
    data: {
      agentId: childAgentId,
      userId,
      toolName: 'archive-tool',
      totalCostCents: 3,
      usageItems: [{ ok: true }],
    },
  });
  await prisma.person.createMany({
    data: [
      { id: personId, userId, firstName: 'Fixture', lastName: 'Person' },
      { id: otherPersonId, userId: otherUserId, firstName: 'Other', lastName: 'Person' },
    ],
  });
  await prisma.messageRecord.create({
    data: {
      personId,
      channel: 'IMESSAGE',
      from: '+10000000000',
      to: '+10000000001',
      timestamp: new Date(),
      message: 'hello',
    },
  });
  await prisma.cookie.create({
    data: {
      userId,
      domain: 'example.com',
      name: 'sid',
      path: '/',
      value: 'secret',
      browserSource: 'chrome',
      expiresUtc: BigInt(12345),
    },
  });
  await prisma.toolSideEffect.create({
    data: {
      operationKey: `vapi.outbound_call:${rootAgentId}:call`,
      operationType: 'vapi.outbound_call',
      status: 'SUCCEEDED',
      response: { id: 'call-1' },
    },
  });
  return {
    userId,
    otherUserId,
    rootAgentId,
    childAgentId,
    toolId,
    messageId,
    staleMessageId,
    personId,
    otherPersonId,
  };
}

async function cleanup(seed: SeededRun): Promise<void> {
  await prisma.message.deleteMany({ where: { id: { in: [seed.messageId, seed.staleMessageId] } } });
  await prisma.toolSideEffect.deleteMany({
    where: { operationKey: { contains: seed.rootAgentId } },
  });
  await prisma.agent.deleteMany({ where: { id: { in: [seed.childAgentId, seed.rootAgentId] } } });
  await prisma.person.deleteMany({ where: { id: { in: [seed.personId, seed.otherPersonId] } } });
  await prisma.tool.deleteMany({ where: { id: seed.toolId } });
  await prisma.user.deleteMany({ where: { userId: { in: [seed.userId, seed.otherUserId] } } });
}

async function testFixtureScopeAndRestore(): Promise<void> {
  const seed = await seedRun();
  try {
    const fixture = await collectFixture(seed.rootAgentId, 'end');
    assert.deepStrictEqual(
      new Set(fixture.agent_ids),
      new Set([seed.rootAgentId, seed.childAgentId])
    );
    assert(ids(fixture.rows.Agent).includes(seed.rootAgentId));
    assert(ids(fixture.rows.Agent).includes(seed.childAgentId));
    assert(ids(fixture.rows.Person).includes(seed.personId));
    assert(!ids(fixture.rows.Person).includes(seed.otherPersonId));
    assert.strictEqual(fixture.rows.Cookie.length, 1);

    await prisma.agent.update({ where: { id: seed.rootAgentId }, data: { goal: 'stale goal' } });
    await prisma.message.create({
      data: {
        id: seed.staleMessageId,
        agentId: seed.rootAgentId,
        text: 'stale',
        role: 'ASSISTANT',
      },
    });
    await restoreFixture(jsonRoundTrip(fixture) as ScopedDbFixture);

    const restoredRoot = await prisma.agent.findUniqueOrThrow({ where: { id: seed.rootAgentId } });
    const messages = await prisma.message.findMany({ where: { agentId: seed.rootAgentId } });
    const otherPerson = await prisma.person.findUnique({ where: { id: seed.otherPersonId } });
    assert.strictEqual(restoredRoot.goal, 'archive root goal');
    assert.deepStrictEqual(
      messages.map((message) => message.id),
      [seed.messageId]
    );
    assert(otherPerson !== null, 'restore must not delete unrelated user rows');
  } finally {
    await cleanup(seed);
  }
}

async function testArchiveEndpointsWriteFixtureAndManifest(): Promise<void> {
  const seed = await seedRun();
  try {
    const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' };
    const start = await request(`${BASE_URL}/api/archive/agent-start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentId: seed.rootAgentId }),
    });
    assert.strictEqual(start.status, 200, JSON.stringify(start.data).slice(0, 300));
    assert((start.data as { fixture?: { ref?: string } }).fixture?.ref);
    for (const artifactPath of [
      'provider/test-provider/request-response.json.gz.enc',
      'media/browser/session/final-screenshot.png',
      'llm/test-dump.json.gz.enc',
    ]) {
      const artifact = await request(`${BASE_URL}/api/archive/artifact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          rootAgentId: seed.rootAgentId,
          path: artifactPath,
          ciphertextB64: Buffer.from(`ciphertext:${artifactPath}`).toString('base64'),
          metadata: {
            path: artifactPath,
            content_type: artifactPath.endsWith('.png') ? 'image/png' : 'application/json',
            plaintext_bytes: 10,
            ciphertext_bytes: Buffer.byteLength(`ciphertext:${artifactPath}`),
          },
        }),
      });
      assert.strictEqual(artifact.status, 200, JSON.stringify(artifact.data).slice(0, 300));
    }

    const finalize = await request(`${BASE_URL}/api/archive/agent-finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rootAgentId: seed.rootAgentId,
        benchmarkTaskName: 'archive-blackbox',
      }),
    });
    assert.strictEqual(finalize.status, 200, JSON.stringify(finalize.data).slice(0, 300));
    assert((finalize.data as { manifest?: { ref?: string } }).manifest?.ref);
    assert((finalize.data as { publicManifestRef?: string }).publicManifestRef);

    const storedManifest = await readArchivedArtifact({
      rootAgentId: seed.rootAgentId,
      objectPath: 'manifest.json.gz.enc',
    });
    assert(storedManifest, 'expected encrypted manifest artifact to be readable');
    const manifest = JSON.parse(decryptAndValidateArtifact(storedManifest).toString('utf8')) as {
      artifact_count: number;
      fixture_count: number;
      provider_count: number;
      media_count: number;
      llm_trace_count: number;
      correlations: { root_agent_id: string; user_id: string; agent_ids: string[] };
      sensitive: {
        fixture_refs: { path: string }[];
        provider_refs: { path: string }[];
        media_refs: { path: string }[];
        llm_trace_refs: { path: string }[];
        artifact_refs: { path: string }[];
      };
    };
    assert.strictEqual(manifest.correlations.root_agent_id, seed.rootAgentId);
    assert.strictEqual(manifest.correlations.user_id, seed.userId);
    assert(manifest.correlations.agent_ids.includes(seed.childAgentId));
    assert(manifest.fixture_count >= 2, 'expected start and end fixtures in manifest counts');
    assert(manifest.provider_count >= 1, 'expected provider ref count');
    assert(manifest.media_count >= 1, 'expected media ref count');
    assert(manifest.llm_trace_count >= 1, 'expected llm trace ref count');
    assert(
      manifest.sensitive.fixture_refs.some((ref) => ref.path === 'db/start.fixture.json.gz.enc')
    );
    assert(
      manifest.sensitive.fixture_refs.some((ref) => ref.path === 'db/end.fixture.json.gz.enc')
    );
    assert(
      manifest.sensitive.provider_refs.some((ref) => ref.path.startsWith('provider/test-provider/'))
    );
    assert(
      manifest.sensitive.media_refs.some(
        (ref) => ref.path === 'media/browser/session/final-screenshot.png'
      )
    );
    assert(
      manifest.sensitive.llm_trace_refs.some((ref) => ref.path === 'llm/test-dump.json.gz.enc')
    );
  } finally {
    await cleanup(seed);
  }
}

async function testEmailProviderBoundaryArchivedWithAgentCorrelation(): Promise<void> {
  const seed = await seedRun();
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-provider-archive-'));
  const oldEnv = {
    TRACE_ARCHIVE_ENABLED: process.env.TRACE_ARCHIVE_ENABLED,
    TRACE_ARCHIVE_BACKEND: process.env.TRACE_ARCHIVE_BACKEND,
    TRACE_ARCHIVE_LOCAL_DIR: process.env.TRACE_ARCHIVE_LOCAL_DIR,
  };
  const originalFetch = global.fetch;
  try {
    process.env.TRACE_ARCHIVE_ENABLED = '1';
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;
    const integration = await prisma.integration.create({
      data: {
        userId: seed.userId,
        name: 'gmail',
        type: 'DATA_SOURCE',
        status: 'CONNECTED',
        isActive: true,
        config: { connectedEmail: 'sender@example.com' },
      },
    });
    await prisma.emailIntegrationCredential.create({
      data: {
        userId: seed.userId,
        integrationId: integration.id,
        provider: 'GMAIL',
        email: 'sender@example.com',
        accessToken: 'gmail-access-token',
        refreshToken: 'gmail-refresh-token',
        scopes: ['https://www.googleapis.com/auth/gmail.send'],
      },
    });
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.strictEqual(
        String(url),
        'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
      );
      assert.strictEqual(init?.method, 'POST');
      assert.strictEqual(
        (init?.headers as Record<string, string>).Authorization,
        'Bearer gmail-access-token'
      );
      return new Response(JSON.stringify({ id: 'gmail-message-1', threadId: 'gmail-thread-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const { sendEmail } = await import('../../domains/integrations/service');
    const result = await sendEmail(seed.userId, {
      agentId: seed.rootAgentId,
      fromEmail: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Archive boundary',
      body: 'Persist this provider boundary',
    });
    assert.deepStrictEqual(result, { id: 'gmail-message-1', threadId: 'gmail-thread-1' });

    const objects = await listArchivedObjects(seed.rootAgentId);
    const emailArtifact = objects.find(
      (object) =>
        object.path.startsWith('provider/email/gmail/') && object.path.endsWith('.json.gz.enc')
    );
    assert(emailArtifact, 'expected Gmail provider archive artifact under root agent');
    const stored = await readArchivedArtifact({
      rootAgentId: seed.rootAgentId,
      objectPath: emailArtifact.path,
    });
    assert(stored, 'expected readable encrypted Gmail provider archive artifact');
    const payload = JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as {
      provider: string;
      request: { body: { raw?: unknown } };
      response: { id?: string; threadId?: string };
      status_code: number;
      success: boolean;
      context: {
        agent_id?: string;
        user_id?: string;
        from_email?: string;
        to?: string;
        subject?: string;
      };
    };
    assert.strictEqual(payload.provider, 'gmail');
    assert.strictEqual(payload.success, true);
    assert.strictEqual(payload.status_code, 200);
    assert.strictEqual(payload.response.id, 'gmail-message-1');
    assert.strictEqual(payload.response.threadId, 'gmail-thread-1');
    assert.strictEqual(typeof payload.request.body.raw, 'string');
    assert.strictEqual(payload.context.agent_id, seed.rootAgentId);
    assert.strictEqual(payload.context.user_id, seed.userId);
    assert.strictEqual(payload.context.from_email, 'sender@example.com');
    assert.strictEqual(payload.context.to, 'recipient@example.com');
    assert.strictEqual(payload.context.subject, 'Archive boundary');
  } finally {
    global.fetch = originalFetch;
    await prisma.integration.deleteMany({ where: { userId: seed.userId, name: 'gmail' } });
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanup(seed);
  }
}

async function runAll(): Promise<void> {
  const tests = [
    { name: 'fixture scope and restore replacement', fn: testFixtureScopeAndRestore },
    {
      name: 'archive endpoints write fixture and manifest',
      fn: testArchiveEndpointsWriteFixtureAndManifest,
    },
    {
      name: 'email provider boundary archived with agent correlation',
      fn: testEmailProviderBoundaryArchivedWithAgentCorrelation,
    },
  ];
  const results: TestResult[] = [];
  for (const test of tests) results.push(await runTest(test.name, test.fn));
  for (const result of results) {
    console.log(
      `  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name}${result.error ? ` -- ${result.error}` : ''} (${result.duration}ms)`
    );
  }
  const failed = results.filter((result) => !result.passed);
  console.log('\n' + '='.repeat(50));
  console.log(
    `\nResults: ${results.length - failed.length} passed, ${failed.length} failed, ${results.length} total`
  );
  if (failed.length > 0) process.exit(1);
}

runAll().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
