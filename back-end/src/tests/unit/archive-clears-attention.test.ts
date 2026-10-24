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
import {
  enqueueTraceArchiveFinalization,
  releaseTraceArchiveDeletion,
  runTraceArchiveFinalizationRetries,
  type TraceArchiveDeletionLease,
} from '../../providers/traceArchiveFinalizationRetry';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  if (process.argv.includes('--kill-retry-only') && !name.startsWith('explicit kill retries'))
    return;
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
    assert.match(kill, /workflowTerminationHandled = false/);
    assert.match(
      kill,
      /sealed\.traceArchiveDeletionLease !== null && workflowTerminationHandled/,
      'unexpected workflow termination failures must retain the R2 finalization lease'
    );
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

  await test('Temporal cleanup trigger fences R2 finalization and deadline preflight is neutral', () => {
    const cleanupMigration = readSrc(
      'prisma',
      'migrations',
      '20260724002500_temporal_cleanup_utc_grace',
      'migration.sql'
    );
    assert.match(
      cleanupMigration,
      /NEW\."deletedAt" IS NOT NULL AND OLD\."deletedAt" IS NULL/,
      'soft-delete must atomically enqueue Temporal cleanup'
    );
    assert.match(cleanupMigration, /INSERT INTO "TemporalWorkflowCleanup"/);
    assert.match(cleanupMigration, /SET "temporalCleanupPending" = true/);

    const retry = readSrc('src', 'providers', 'traceArchiveFinalizationRetry.ts');
    assert.match(retry, /if \(agent\.temporalCleanupPending\)/);
    assert.match(
      retry,
      /assertBeforeDeadline\(options\.deadlineAtMs\);\s*} catch \(error\) {\s*await unclaim\(obligation\);\s*throw error;\s*}\s*try {\s*await assertDeletedTreeIsTerminal/,
      'a deadline reached before R2 work must release the claim without retry backoff'
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

  await test('failed root finalization stays durable and repeated delete respects backoff', async () => {
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

      const stillRetained = await prisma.traceArchiveFinalization.findUniqueOrThrow({
        where: { rootAgentId: rootId },
      });
      assert.equal(stillRetained.attemptCount, 1);
      assert.equal(stillRetained.notBefore.getTime(), retained.notBefore.getTime());
      assert.equal(stillRetained.lastError, retained.lastError);
      assert.deepEqual(
        await listArchivedObjectsStrict(rootId),
        [],
        'an idempotent repeated delete must not bypass retry backoff'
      );

      assert.deepEqual(
        await runTraceArchiveFinalizationRetries({
          rootAgentIds: [rootId],
          batchSize: 1,
          maxConcurrency: 1,
          ignoreGrace: true,
        }),
        { discovered: 1, finalized: 1 }
      );

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

  await test('finalization waits for deletion ownership and terminal descendants', async () => {
    const userId = `archive-ordering-${randomUUID()}`;
    const rootId = randomUUID();
    const childId = randomUUID();
    const archiveDir = mkdtempSync(join(tmpdir(), 'rose-agent-kill-ordering-'));
    const priorArchiveBackend = process.env.TRACE_ARCHIVE_BACKEND;
    const priorArchiveEnabled = process.env.TRACE_ARCHIVE_ENABLED;
    const priorArchiveDir = process.env.TRACE_ARCHIVE_LOCAL_DIR;
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;

    await prisma.user.create({
      data: { userId, phone: `+1553${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: rootId,
        userId,
        goal: 'root archive ordering',
        status: 'ACTIVE',
        deletedAt: new Date(),
        busId: rootId,
        verifier: { create: {} },
      },
    });
    await prisma.agent.create({
      data: {
        id: childId,
        userId,
        parentAgentId: rootId,
        goal: 'child archive ordering',
        status: 'ACTIVE',
        deletedAt: new Date(),
        temporalCleanupPending: true,
        busId: rootId,
        verifier: { create: {} },
      },
    });

    try {
      let deletionLease: TraceArchiveDeletionLease | null = null;
      await prisma.$transaction(async (tx) => {
        deletionLease = await enqueueTraceArchiveFinalization(tx, rootId);
      });
      assert.ok(deletionLease);

      assert.deepEqual(
        await runTraceArchiveFinalizationRetries({
          rootAgentIds: [rootId],
          batchSize: 1,
          maxConcurrency: 1,
          ignoreGrace: true,
        }),
        { discovered: 0, finalized: 0 },
        'an active recursive deletion lease must not be claimable'
      );

      await releaseTraceArchiveDeletion(deletionLease);
      await assert.rejects(
        runTraceArchiveFinalizationRetries({
          rootAgentIds: [rootId],
          batchSize: 1,
          maxConcurrency: 1,
          ignoreGrace: true,
        }),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.message.includes(
            `Trace archive agent ${childId} still has Temporal cleanup pending`
          ),
        'a descendant Temporal cleanup obligation must block the end fixture, and the error must name it'
      );
      assert.equal(
        (
          await prisma.traceArchiveFinalization.findUniqueOrThrow({
            where: { rootAgentId: rootId },
          })
        ).attemptCount,
        1
      );
      const beforeSecondFailure = Date.now();
      await assert.rejects(
        runTraceArchiveFinalizationRetries({
          rootAgentIds: [rootId],
          batchSize: 1,
          maxConcurrency: 1,
          ignoreGrace: true,
        }),
        AggregateError
      );
      const twiceRetained = await prisma.traceArchiveFinalization.findUniqueOrThrow({
        where: { rootAgentId: rootId },
      });
      assert.equal(twiceRetained.attemptCount, 2);
      assert.ok(
        twiceRetained.notBefore.getTime() >= beforeSecondFailure + 110_000,
        'the second failure must back off for approximately two minutes'
      );
      assert.ok(
        twiceRetained.notBefore.getTime() <= Date.now() + 125_000,
        'the second failure backoff must remain bounded'
      );

      await prisma.agent.update({
        where: { id: childId },
        data: { temporalCleanupPending: false },
      });
      assert.deepEqual(
        await runTraceArchiveFinalizationRetries({
          rootAgentIds: [rootId],
          batchSize: 1,
          maxConcurrency: 1,
          ignoreGrace: true,
        }),
        { discovered: 1, finalized: 1 }
      );
      assert.equal(
        await prisma.traceArchiveFinalization.findUnique({ where: { rootAgentId: rootId } }),
        null
      );
      assert.equal((await inspectFinalizedManifest(rootId)).status, 'current');
    } finally {
      await prisma.agent.deleteMany({ where: { id: { in: [childId, rootId] } } });
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

  await test('explicit kill retries cleanup after archival and a transient failure', async () => {
    const userId = `kill-retry-${randomUUID()}`;
    const id = randomUUID();
    const original = prisma.agentAttentionRequest.deleteMany.bind(prisma.agentAttentionRequest);
    const previousArchive = process.env.TRACE_ARCHIVE_ENABLED;
    process.env.TRACE_ARCHIVE_ENABLED = 'false';
    try {
      await prisma.user.create({ data: { userId, phone: `+1553${String(Date.now()).slice(-7)}` } });
      await prisma.agent.create({ data: { id, userId, goal: 'kill retry', status: 'ACTIVE' } });
      await prisma.agentAttentionRequest.create({
        data: { userId, agentId: id, workflowId: id, question: 'retry fixture' },
      });
      let failed = false;
      prisma.agentAttentionRequest.deleteMany = (async (...args: Parameters<typeof original>) => {
        if (!failed) {
          failed = true;
          throw new Error('synthetic transient cleanup failure');
        }
        return original(...args);
      }) as typeof prisma.agentAttentionRequest.deleteMany;
      await assert.rejects(deleteAgentRecursive(id, { retryArchived: true }), /transient cleanup/);
      assert.ok((await prisma.agent.findUniqueOrThrow({ where: { id } })).deletedAt);
      assert.equal(await prisma.agentAttentionRequest.count({ where: { agentId: id } }), 1);
      await deleteAgentRecursive(id, { retryArchived: true });
      assert.equal(await prisma.agentAttentionRequest.count({ where: { agentId: id } }), 0);
    } finally {
      prisma.agentAttentionRequest.deleteMany = original;
      await prisma.agent.deleteMany({ where: { id } });
      await prisma.user.deleteMany({ where: { userId } });
      if (previousArchive === undefined) delete process.env.TRACE_ARCHIVE_ENABLED;
      else process.env.TRACE_ARCHIVE_ENABLED = previousArchive;
    }
  });

  await test('deleting a completed root discharges its Temporal cleanup and finalizes the archive', async () => {
    // descend-full69 r004-j0055 (agent 5cce9d33): COMPLETED fired the schema
    // trigger's TemporalWorkflowCleanup row (5-minute grace). The teardown
    // DELETE terminated the workflow itself ("already completed") but left that
    // row, so the forced post-delete finalize failed with
    // "still has Temporal cleanup pending" behind an AggregateError and the
    // obligation was retained (never retried where the crons are disabled).
    const userId = `archive-completed-${randomUUID()}`;
    const rootId = randomUUID();
    const archiveDir = mkdtempSync(join(tmpdir(), 'rose-agent-kill-completed-'));
    const priorArchiveBackend = process.env.TRACE_ARCHIVE_BACKEND;
    const priorArchiveEnabled = process.env.TRACE_ARCHIVE_ENABLED;
    const priorArchiveDir = process.env.TRACE_ARCHIVE_LOCAL_DIR;
    process.env.TRACE_ARCHIVE_BACKEND = 'local';
    process.env.TRACE_ARCHIVE_ENABLED = 'true';
    process.env.TRACE_ARCHIVE_LOCAL_DIR = archiveDir;
    const terminated: string[] = [];
    const cleanupTerminated: string[] = [];

    await prisma.user.create({
      data: { userId, phone: `+1554${String(Date.now()).slice(-7)}` },
    });
    await prisma.agent.create({
      data: {
        id: rootId,
        userId,
        goal: 'completed root archive',
        status: 'COMPLETED',
        busId: rootId,
        temporalWorkflowId: rootId,
        temporalFirstExecutionRunId: `run-${rootId}`,
        verifier: { create: {} },
      },
    });

    try {
      assert.equal(
        (await prisma.agent.findUniqueOrThrow({ where: { id: rootId } })).temporalCleanupPending,
        true,
        'fixture: the terminal transition must enqueue Temporal cleanup like production'
      );

      await deleteAgentRecursive(
        rootId,
        { terminateReason: 'unit-test' },
        {
          terminateWorkflow: async (workflowId) => {
            terminated.push(workflowId);
            throw new Error('workflow execution already completed');
          },
          workflowCleanup: {
            terminate: async (execution) => {
              cleanupTerminated.push(execution.workflowId);
            },
          },
        }
      );

      const obligation = await prisma.traceArchiveFinalization.findUnique({
        where: { rootAgentId: rootId },
      });
      assert.equal(
        obligation,
        null,
        `the post-delete finalization must complete, got lastError=${obligation?.lastError ?? ''}`
      );
      assert.equal((await inspectFinalizedManifest(rootId)).status, 'current');
      assert.equal(await prisma.temporalWorkflowCleanup.count({ where: { agentId: rootId } }), 0);
      assert.equal(
        (await prisma.agent.findUniqueOrThrow({ where: { id: rootId } })).temporalCleanupPending,
        false
      );
      assert.deepEqual(terminated, [rootId]);
      assert.deepEqual(cleanupTerminated, [rootId]);
    } finally {
      await prisma.traceArchiveFinalization.deleteMany({ where: { rootAgentId: rootId } });
      await prisma.agent.deleteMany({ where: { id: rootId } });
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
