#!/usr/bin/env tsx
/**
 * Soft-delete / archive must clear AgentAttentionRequest rows, and every
 * surface must call the single canonical kill in providers/agentKill.ts.
 *
 * Run: DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria \
 *      npx tsx src/tests/unit/archive-clears-attention.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';

config();

import { prisma } from '../../providers/database';
import { deleteAgentRecursive } from '../../providers/agentKill';
import { listArchivedObjectsStrict } from '../../providers/traceArchive';
import { inspectFinalizedManifest } from '../../providers/traceArchiveManifest';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  PASS ${name}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    process.stdout.write(`  FAIL ${name} - ${message}\n`);
  }
}

function readSrc(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

function assertImportsCanonicalKill(source: string, label: string): void {
  assert.match(
    source,
    /from ['"].*agentKill['"]/,
    `${label} must import providers/agentKill (not a parallel soft-delete path)`
  );
  assert.doesNotMatch(
    source,
    /softDeleteAgentAndChildren/,
    `${label} must not call the removed CTE soft-delete helper`
  );
}

async function main(): Promise<void> {
  await test('canonical kill lives only in providers/agentKill.ts', () => {
    const kill = readSrc('src', 'providers', 'agentKill.ts');
    assert.match(kill, /export async function deleteAgentRecursive/);
    assert.match(kill, /agentAttentionRequest\.deleteMany/);
    assert.match(kill, /deletedAt:\s*new Date\(\)/);
    assert.match(kill, /cleanupAgentSessions/);
    assert.match(kill, /enqueueTraceArchiveFinalization\(tx, agentId\)/);
    assert.match(kill, /runTraceArchiveFinalizationRetries/);
    assert.match(
      readSrc('src', 'serverCron.ts'),
      /scheduleTraceArchiveFinalizationRetries\(isProduction\)/
    );
    // Soft-delete under workflow-generation lock before recursing children so a
    // concurrent child create cannot commit after the descendant snapshot.
    assert.match(kill, /lockAgentWorkflowGeneration/);
    assert.match(kill, /runTransactionWithRetry/);
    const softDeleteIdx = kill.indexOf('deletedAt: new Date()');
    const recurseIdx = kill.indexOf('for (const childId of sealed.childIds)');
    assert.ok(softDeleteIdx > 0 && recurseIdx > softDeleteIdx);

    const helpers = readSrc('src', 'providers', 'smsSupervisor', 'supervisorTools.helpers.ts');
    assert.doesNotMatch(
      helpers,
      /export async function deleteAgentRecursive/,
      'SMS helpers must not own a second deleteAgentRecursive'
    );

    const smsRepo = readSrc('src', 'domains', 'sms-webhook', 'repo.ts');
    assert.doesNotMatch(
      smsRepo,
      /softDeleteAgentAndChildren|DELETE FROM "AgentAttentionRequest"/,
      'sms-webhook repo must not soft-delete agents outside agentKill'
    );
  });

  await test('UI Archive, SMS kill, and /clear all import agentKill', () => {
    assertImportsCanonicalKill(
      readSrc('src', 'domains', 'agents', 'agentLifecycleService.ts'),
      'UI archive service'
    );
    assertImportsCanonicalKill(
      readSrc('src', 'providers', 'smsSupervisor', 'supervisorTools.ts'),
      'SMS kill_agent'
    );
    assertImportsCanonicalKill(
      readSrc('src', 'domains', 'sms-webhook', 'service.ts'),
      'SMS /clear'
    );
  });

  await test('deleteAgentRecursive removes attention for parent + child', async () => {
    const userId = `archive-attn-${randomUUID()}`;
    const parentId = randomUUID();
    const childId = randomUUID();
    const archiveDir = mkdtempSync(join(tmpdir(), 'rose-agent-kill-archive-'));
    const priorArchiveBackend = process.env.TRACE_ARCHIVE_BACKEND;
    const priorArchiveEnabled = process.env.TRACE_ARCHIVE_ENABLED;
    const priorArchiveDir = process.env.TRACE_ARCHIVE_LOCAL_DIR;
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;

    await prisma.user.create({
      data: { userId, phone: `+1555${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: parentId,
        userId,
        goal: 'parent archive attention',
        status: 'ACTIVE',
        busId: parentId,
        verifier: { create: {} },
      },
    });
    await prisma.agent.create({
      data: {
        id: childId,
        userId,
        parentAgentId: parentId,
        goal: 'child archive attention',
        status: 'ACTIVE',
        busId: parentId,
        verifier: { create: {} },
      },
    });
    await prisma.agentAttentionRequest.createMany({
      data: [
        {
          userId,
          agentId: parentId,
          workflowId: `wf-parent-${parentId}`,
          question: 'parent?',
        },
        {
          userId,
          agentId: childId,
          workflowId: `wf-child-${childId}`,
          question: 'child?',
        },
      ],
    });

    try {
      const before = await prisma.agentAttentionRequest.count({
        where: { agentId: { in: [parentId, childId] } },
      });
      assert.equal(before, 2);

      await deleteAgentRecursive(parentId, { terminateReason: 'unit-test' });

      const after = await prisma.agentAttentionRequest.count({
        where: { agentId: { in: [parentId, childId] } },
      });
      assert.equal(after, 0, 'attention rows for the archived tree must be gone');

      const archived = await prisma.agent.findMany({
        where: { id: { in: [parentId, childId] } },
        select: { id: true, deletedAt: true },
      });
      assert.equal(archived.length, 2);
      assert.ok(archived.every((row) => row.deletedAt !== null));

      const rootObjects = await listArchivedObjectsStrict(parentId);
      const rootPaths = new Set(rootObjects.map((object) => object.path));
      assert.ok(rootPaths.has('db/end.fixture.json.gz.enc'));
      assert.ok(rootPaths.has('manifest.json.gz.enc'));
      assert.ok(rootPaths.has('manifest.public.json'));
      assert.equal((await inspectFinalizedManifest(parentId)).status, 'current');
      assert.deepEqual(await listArchivedObjectsStrict(childId), []);
    } finally {
      await prisma.agentAttentionRequest.deleteMany({
        where: { agentId: { in: [parentId, childId] } },
      });
      await prisma.agent.deleteMany({ where: { id: { in: [parentId, childId] } } });
      await prisma.user.deleteMany({ where: { userId } });
      rmSync(archiveDir, { recursive: true, force: true });
      if (priorArchiveBackend === undefined) delete process.env.TRACE_ARCHIVE_BACKEND;
      else process.env.TRACE_ARCHIVE_BACKEND = priorArchiveBackend;
      if (priorArchiveEnabled === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
      else process.env.TRACE_ARCHIVE_ENABLED = priorArchiveEnabled;
      if (priorArchiveDir === undefined) delete process.env.TRACE_ARCHIVE_LOCAL_DIR;
      else process.env.TRACE_ARCHIVE_LOCAL_DIR = priorArchiveDir;
    }
  });

  await test('failed root finalization stays durable and a repeated delete retries it', async () => {
    const userId = `archive-retry-${randomUUID()}`;
    const rootId = randomUUID();
    const testDir = mkdtempSync(join(tmpdir(), 'rose-agent-kill-retry-'));
    const invalidArchiveRoot = join(testDir, 'not-a-directory');
    const recoveredArchiveRoot = join(testDir, 'recovered');
    writeFileSync(invalidArchiveRoot, 'block mkdir');
    const priorArchiveBackend = process.env.TRACE_ARCHIVE_BACKEND;
    const priorArchiveEnabled = process.env.TRACE_ARCHIVE_ENABLED;
    const priorArchiveDir = process.env.TRACE_ARCHIVE_LOCAL_DIR;
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = invalidArchiveRoot;

    await prisma.user.create({
      data: { userId, phone: `+1554${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: rootId,
        userId,
        goal: 'root archive retry',
        status: 'ACTIVE',
        busId: rootId,
        verifier: { create: {} },
      },
    });

    try {
      await deleteAgentRecursive(rootId, { terminateReason: 'unit-test retry' });

      const retained = await prisma.traceArchiveFinalization.findUnique({
        where: { rootAgentId: rootId },
      });
      assert.ok(retained, 'failed R2 finalization must retain an outbox row');
      assert.equal(retained.attemptCount, 1);
      assert.ok(retained.lastError);
      assert.ok(
        (await prisma.agent.findUniqueOrThrow({ where: { id: rootId } })).deletedAt,
        'the retry obligation must survive after the root is already soft-deleted'
      );

      process.env.TRACE_ARCHIVE_LOCAL_DIR = recoveredArchiveRoot;
      await deleteAgentRecursive(rootId, { terminateReason: 'unit-test retry' });

      assert.equal(
        await prisma.traceArchiveFinalization.findUnique({ where: { rootAgentId: rootId } }),
        null,
        'successful retry must clear the durable obligation'
      );
      const paths = new Set((await listArchivedObjectsStrict(rootId)).map((object) => object.path));
      assert.ok(paths.has('db/end.fixture.json.gz.enc'));
      assert.ok(paths.has('manifest.json.gz.enc'));
      assert.ok(paths.has('manifest.public.json'));
      assert.equal((await inspectFinalizedManifest(rootId)).status, 'current');
    } finally {
      await prisma.agent.deleteMany({ where: { id: rootId } });
      await prisma.user.deleteMany({ where: { userId } });
      rmSync(testDir, { recursive: true, force: true });
      if (priorArchiveBackend === undefined) delete process.env.TRACE_ARCHIVE_BACKEND;
      else process.env.TRACE_ARCHIVE_BACKEND = priorArchiveBackend;
      if (priorArchiveEnabled === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
      else process.env.TRACE_ARCHIVE_ENABLED = priorArchiveEnabled;
      if (priorArchiveDir === undefined) delete process.env.TRACE_ARCHIVE_LOCAL_DIR;
      else process.env.TRACE_ARCHIVE_LOCAL_DIR = priorArchiveDir;
    }
  });

  process.stdout.write(`\nResults: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
