#!/usr/bin/env tsx

import assert from 'node:assert';
import { runCurationPoolControls } from './archive-curation-pool.controls';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import { GOOGLE_OAUTH_SCOPES } from '../../domains/integrations/googleScopes';
import {
  collectFixture,
  collectFixtureSnapshot,
  restoreFixture,
  type ScopedDbFixture,
} from '../../domains/archive/fixture';
import {
  decryptAndValidateArtifact,
  encryptArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from '../../providers/traceArchive';
import {
  assertLateArchiveBatchConvergence,
  assertLateArchiveManifestConvergence,
} from './archive-late-manifest.helper';
import {
  ARCHIVE_BENCHMARK_TASK,
  purgeOrphanedArchiveMemories,
  testCleanupLeavesNoPlannerMemoryRows,
  trackSeededRootAgent,
} from './archive-planner-memory.helper';
import { ids, jsonRoundTrip, request, runTest, type TestResult } from './archive-blackbox.support';
import {
  testFinalizeDeleteSeeksByRoot,
  testFixtureExcludesUserLifetimeHistory,
  testLateLlmArtifactIndexesOnlyItself,
} from './archive-run-cost.helper';

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

async function seedRun(): Promise<SeededRun> {
  const userId = `archive-user-${RUN_ID}-${randomUUID()}`;
  const otherUserId = `archive-other-${RUN_ID}-${randomUUID()}`;
  const rootAgentId = randomUUID();
  trackSeededRootAgent(rootAgentId);
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
        model: 'rose-labs/rose-1-flash',
        status: 'COMPLETED',
        busId: rootAgentId,
      },
      {
        id: childAgentId,
        userId,
        goal: 'archive child goal',
        model: 'rose-labs/rose-1-flash',
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
  // PlannerMemory has no FK to Agent (history outlives the run), so finalize's row needs its own delete.
  await prisma.plannerMemory.deleteMany({ where: { id: seed.rootAgentId } });
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
    // Lifetime user history (Person, Cookie, ...) belongs to the base image;
    // see testFixtureExcludesUserLifetimeHistory.
    assert.strictEqual(fixture.user_id, seed.userId);
    assert.deepStrictEqual(
      fixture.rows.User.map((row) => (row as { userId?: unknown }).userId),
      [seed.userId]
    );

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

async function withSeededRun(fn: (seed: SeededRun) => Promise<void>): Promise<void> {
  const seed = await seedRun();
  try {
    await fn(seed);
  } finally {
    await prisma.agentTrajectorySearch.deleteMany({ where: { rootAgentId: seed.rootAgentId } });
    await cleanup(seed);
  }
}

async function testStartFixtureSnapshotExcludesPostReadyWrites(): Promise<void> {
  const seed = await seedRun();
  const postReadyChildId = randomUUID();
  const postReadyMessageId = randomUUID();
  try {
    const fixture = await collectFixtureSnapshot(seed.rootAgentId, 'start', async () => {
      await prisma.agent.create({
        data: {
          id: postReadyChildId,
          userId: seed.userId,
          goal: 'created after snapshot readiness',
          model: 'rose-labs/rose-1-flash',
          status: 'COMPLETED',
          parentAgentId: seed.rootAgentId,
          busId: seed.rootAgentId,
          depth: 1,
        },
      });
      await prisma.message.create({
        data: {
          id: postReadyMessageId,
          agentId: seed.rootAgentId,
          text: 'created after snapshot readiness',
          role: 'ASSISTANT',
        },
      });
    });

    assert(
      !ids(fixture.rows.Agent).includes(postReadyChildId),
      'repeatable-read fixture must exclude an agent created after snapshot readiness'
    );
    assert(
      !ids(fixture.rows.Message).includes(postReadyMessageId),
      'repeatable-read fixture must exclude a message created after snapshot readiness'
    );
    assert(ids(fixture.rows.Agent).includes(seed.rootAgentId));
    assert(ids(fixture.rows.Message).includes(seed.messageId));
  } finally {
    await prisma.message.deleteMany({ where: { id: postReadyMessageId } });
    await prisma.agent.deleteMany({ where: { id: postReadyChildId } });
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
    // archiveBytes() returns null ONLY when the trace archive is disabled
    // (TRACE_ARCHIVE_ENABLED=0 — the /deploy Step-5 stack config); every real
    // write failure throws instead. Skip the write assertions on such stacks;
    // the coverage-gate backend runs archive-enabled, so they still execute on
    // every deploy.
    if ((start.data as { fixture?: { ref?: string } | null }).fixture === null) {
      console.log(
        '    [skipped] trace archive disabled on target backend (TRACE_ARCHIVE_ENABLED=0)'
      );
      return;
    }
    assert((start.data as { fixture?: { ref?: string } }).fixture?.ref);

    // The manifest is written at creation so a run that crashes before finalize
    // still has a classifiable, world-model-ingestible bundle. Read it back
    // immediately after start — before any artifacts or finalize exist.
    const startManifestArtifact = await readArchivedArtifact({
      rootAgentId: seed.rootAgentId,
      objectPath: 'manifest.json.gz.enc',
    });
    assert(startManifestArtifact, 'expected a manifest to exist immediately after agent start');
    const startManifest = JSON.parse(
      decryptAndValidateArtifact(startManifestArtifact).toString('utf8')
    ) as {
      world_model_mode: string;
      finalized: boolean;
      correlations: { root_agent_id: string; agent_ids: string[] };
    };
    assert.strictEqual(
      startManifest.world_model_mode,
      'real',
      'start manifest must be classifiable (real mode) so the bundle is ingestible'
    );
    assert.strictEqual(
      startManifest.finalized,
      false,
      'start manifest must be marked not-yet-finalized'
    );
    assert.strictEqual(startManifest.correlations.root_agent_id, seed.rootAgentId);

    const invalidArtifact = await request(`${BASE_URL}/api/archive/artifact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rootAgentId: seed.rootAgentId,
        path: 'provider/test-provider/bad.json.gz.enc',
        ciphertextB64: Buffer.from('not-a-valid-envelope').toString('base64'),
        metadata: {
          path: 'provider/test-provider/bad.json.gz.enc',
          content_type: 'application/json',
        },
      }),
    });
    assert.strictEqual(invalidArtifact.status, 400, JSON.stringify(invalidArtifact.data));

    for (const artifactPath of [
      'provider/test-provider/request-response.json.gz.enc',
      'media/browser/session/final-screenshot.png.enc',
      'llm/test-dump.json.gz.enc',
    ]) {
      const encrypted = encryptArtifact(
        artifactPath,
        Buffer.from(
          artifactPath.startsWith('llm/')
            ? JSON.stringify({
                root_agent_id: seed.rootAgentId,
                agent_id: seed.rootAgentId,
                messages: [{ role: 'assistant', content: 'Archived test LLM result' }],
              })
            : `ciphertext:${artifactPath}`
        ),
        artifactPath.endsWith('.png.enc') ? 'image/png' : 'application/json'
      );
      assert(encrypted, 'expected test artifact encryption to be available');
      const artifact = await request(`${BASE_URL}/api/archive/artifact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          rootAgentId: seed.rootAgentId,
          path: artifactPath,
          ciphertextB64: encrypted.ciphertext.toString('base64'),
          metadata: encrypted.metadata,
        }),
      });
      assert.strictEqual(artifact.status, 200, JSON.stringify(artifact.data).slice(0, 300));
    }

    const finalize = await request(`${BASE_URL}/api/archive/agent-finalize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        rootAgentId: seed.rootAgentId,
        benchmarkTaskName: ARCHIVE_BENCHMARK_TASK,
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
      world_model_mode: string;
      finalized: boolean;
      correlations: { root_agent_id: string; user_id: string; agent_ids: string[] };
      sensitive: {
        fixture_refs: { path: string }[];
        provider_refs: { path: string }[];
        media_refs: { path: string }[];
        llm_trace_refs: { path: string }[];
        artifact_refs: { path: string }[];
      };
    };
    assert.strictEqual(
      manifest.world_model_mode,
      'real',
      'finalize without worldModelMode must record a real run'
    );
    assert.strictEqual(
      manifest.finalized,
      true,
      'finalize must update the start manifest to finalized=true'
    );
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
        (ref) => ref.path === 'media/browser/session/final-screenshot.png.enc'
      )
    );
    assert(
      manifest.sensitive.llm_trace_refs.some((ref) => ref.path === 'llm/test-dump.json.gz.enc')
    );
    // The manifest is written at start, so listArchivedObjects() sees it during
    // finalize. It must never index its own control files.
    assert(
      !manifest.sensitive.artifact_refs.some(
        (ref) =>
          ref.path === 'manifest.json.gz.enc' ||
          ref.path === 'manifest.public.json' ||
          ref.path === 'manifest.finalization-fence.json'
      ),
      'finalize manifest must not index the manifest control files'
    );

    // A late successful POST must not return until both manifests converge.
    await assertLateArchiveManifestConvergence({
      baseUrl: BASE_URL,
      headers,
      rootAgentId: seed.rootAgentId,
    });
    await assertLateArchiveBatchConvergence({
      baseUrl: BASE_URL,
      headers,
      rootAgentId: seed.rootAgentId,
    });
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
        scopes: [...GOOGLE_OAUTH_SCOPES],
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
      request: { method?: string; url?: string; body?: unknown };
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
    assert.strictEqual(payload.request.method, 'POST');
    assert.strictEqual(
      payload.request.url,
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
    );
    assert.strictEqual(payload.request.body, undefined);
    assert.strictEqual(payload.context.agent_id, seed.rootAgentId);
    assert.strictEqual(payload.context.user_id, seed.userId);
    assert.strictEqual(payload.context.from_email, undefined);
    assert.strictEqual(payload.context.to, undefined);
    assert.strictEqual(payload.context.subject, undefined);
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
    {
      name: 'curation pool stops claims and joins in-flight work before rejecting',
      fn: runCurationPoolControls,
    },
    { name: 'fixture scope and restore replacement', fn: testFixtureScopeAndRestore },
    {
      name: "run fixture excludes the user's lifetime history",
      fn: () => withSeededRun(testFixtureExcludesUserLifetimeHistory),
    },
    {
      name: 'finalize search-index delete seeks by root',
      fn: () => withSeededRun(testFinalizeDeleteSeeksByRoot),
    },
    {
      name: 'late llm artifact indexes only itself',
      fn: () =>
        withSeededRun((seed) =>
          testLateLlmArtifactIndexesOnlyItself({
            baseUrl: BASE_URL,
            headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
            seed,
          })
        ),
    },
    {
      name: 'start fixture snapshot excludes post-ready writes',
      fn: testStartFixtureSnapshotExcludesPostReadyWrites,
    },
    {
      name: 'archive endpoints write fixture and manifest',
      fn: testArchiveEndpointsWriteFixtureAndManifest,
    },
    {
      name: 'email provider boundary archived with agent correlation',
      fn: testEmailProviderBoundaryArchivedWithAgentCorrelation,
    },
    {
      name: 'cleanup leaves no planner-memory history rows',
      fn: testCleanupLeavesNoPlannerMemoryRows,
    },
  ];
  await purgeOrphanedArchiveMemories();
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
