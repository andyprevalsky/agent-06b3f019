/** Real Postgres locks/commit visibility, separate from mocked native RPC proofs. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import type { AdmissionTransaction } from '../../providers/workflowQueueAdmission';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow queue admission real Postgres');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  // Validate before importing any provider that constructs the default client.
  const url = process.env.DATABASE_URL;
  assert.equal(nonLocalDatabaseReason(url), null, 'explicit local test database required');
  const schema = `queue_admission_pg_${randomUUID().replaceAll('-', '')}`;
  const isolated = new URL(url!);
  isolated.searchParams.set('schema', schema);
  isolated.searchParams.set('connection_limit', '8');
  const db = new PrismaClient({
    datasources: { db: { url: isolated.toString() } },
    log: [{ emit: 'event', level: 'query' }],
  });
  let captureMembership = false;
  let capturedQuery: { query: string; params: string } | undefined;
  db.$on('query', (event) => {
    if (captureMembership) capturedQuery = { query: event.query, params: event.params };
  });
  // The engine's one-time TLS setenv must finish before another client reads process.env.
  await db.$connect();
  const { claimWorkflowStart, acknowledgeWorkflowStart, beginQueueRetirement, queueAdmissionKey } =
    await import('../../providers/workflowQueueAdmission');
  const { lockAgentWorkflowGeneration } = await import('../../providers/workflowGeneration');
  const { workflowStartMembership } = await import('../../providers/workflowStartPending');
  const { prisma: defaultClient } = await import('../../providers/database');
  const source = `navi-agent-tasks@pg-source-${schema}`;
  const target = `navi-agent-tasks@pg-target-${schema}`;
  const transaction: AdmissionTransaction = (fn, options) =>
    db.$transaction(fn, {
      maxWait: options?.maxWait ?? 5_000,
      timeout: options?.timeout ?? 10_000,
    });
  async function waiting(pid: number, finished?: () => boolean) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (finished?.()) return false;
      const rows = await db.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_locks
                      WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS waiting
      `;
      if (rows[0]?.waiting === true) return true;
      await delay(5);
    }
    assert.fail('the actual Postgres advisory-lock waiter did not appear');
  }
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."ToolSideEffect" (
      "id" TEXT PRIMARY KEY, "operationKey" TEXT NOT NULL UNIQUE,
      "operationType" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'STARTED',
      "externalId" TEXT, "request" JSONB, "response" JSONB, "error" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL)`);
    await db.$executeRawUnsafe(`CREATE TABLE "${schema}"."AgentQueuePointer" (
      "id" TEXT PRIMARY KEY DEFAULT 'singleton', "taskQueue" TEXT NOT NULL,
      "surfaceHash" TEXT NOT NULL, "updatedBy" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL)`);
    // Mirror the existing Prisma model's indexes; no production migration.
    for (const column of ['operationType', 'status', 'externalId']) {
      await db.$executeRawUnsafe(
        `CREATE INDEX "ToolSideEffect_${column}_idx" ON "${schema}"."ToolSideEffect" ("${column}")`
      );
    }
    await db.agentQueuePointer.create({
      data: {
        id: 'singleton',
        taskQueue: target,
        surfaceHash: 'target',
      },
    });
    for (const [queue, surfaceHash] of [
      [source, 'source'],
      [target, 'target'],
    ]) {
      await db.toolSideEffect.create({
        data: {
          operationKey: queueAdmissionKey(queue),
          operationType: 'AGENT_QUEUE_ADMISSION',
          status: 'OPEN',
          externalId: queue,
          request: {
            version: 1,
            queue,
            surfaceHash,
            incarnation: schema,
            owner: 'pg-deploy',
            phase: 'OPEN',
            legacyCoverage: 'UNKNOWN',
          },
        },
      });
    }

    await test('exclusive closure waits for the real uncommitted admission and redirects later starts', async () => {
      const entered = deferred();
      const release = deferred();
      const closingEntered = deferred();
      let closingPid = 0;
      const heldTransaction: AdmissionTransaction = (fn, options) =>
        db.$transaction(
          async (tx) => {
            const result = await fn(tx);
            entered.resolve();
            await release.promise;
            return result;
          },
          { maxWait: 5_000, timeout: options?.timeout ?? 10_000 }
        );
      const closingTransaction: AdmissionTransaction = (fn) =>
        db.$transaction(async (tx) => {
          closingPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
            .pid;
          closingEntered.resolve();
          return fn(tx);
        });
      const pending = claimWorkflowStart(
        'pg-first',
        'pg-first',
        source,
        true,
        Date.now() + 15_000,
        heldTransaction
      );
      let closing: Promise<unknown> | undefined;
      try {
        await entered.promise;
        closing = beginQueueRetirement(source, 'pg-deploy', closingTransaction);
        await closingEntered.promise;
        await waiting(closingPid);
        assert.equal(
          await db.toolSideEffect.count({ where: { operationType: 'AGENT_QUEUE_START' } }),
          0,
          'uncommitted member must not appear committed to another connection'
        );
      } finally {
        release.resolve();
        await pending;
        await closing;
      }
      const members = await db.toolSideEffect.findMany({
        where: { operationType: 'AGENT_QUEUE_START' },
      });
      assert.equal(members.length, 1, 'member commits before closure is allowed through');
      const next = await claimWorkflowStart(
        'pg-later',
        'pg-later',
        source,
        true,
        Date.now() + 15_000,
        transaction
      );
      assert.equal(next.queue, target);
      assert.equal(next.requestedQueue, source);
    });

    await test('one agent generation lock blocks its own admission while another agent proceeds', async () => {
      const held = deferred();
      const release = deferred();
      const attempting = deferred();
      let waitingPid = 0;
      const holder = db.$transaction(
        async (tx) => {
          await lockAgentWorkflowGeneration(tx, 'pg-locked-agent');
          held.resolve();
          await release.promise;
        },
        { timeout: 10_000 }
      );
      let blocked: ReturnType<typeof claimWorkflowStart> | undefined;
      try {
        await held.promise;
        const observed: AdmissionTransaction = (fn) =>
          db.$transaction(async (tx) => {
            waitingPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]
              .pid;
            attempting.resolve();
            return fn(tx);
          });
        blocked = claimWorkflowStart(
          'pg-locked-agent',
          'pg-locked-agent',
          target,
          true,
          Date.now() + 15_000,
          observed
        );
        await attempting.promise;
        await waiting(waitingPid);
        const other = await claimWorkflowStart(
          'pg-independent-agent',
          'pg-independent-agent',
          target,
          true,
          Date.now() + 15_000,
          transaction
        );
        assert.equal(other.queue, target, 'independent starts must not wait behind another agent');
      } finally {
        release.resolve();
        await holder;
        await blocked;
      }
      assert.equal(
        await db.toolSideEffect.count({ where: { operationType: 'AGENT_QUEUE_START' } }),
        4
      );
    });
    await test('native acknowledgement cannot change membership during a locked terminal acceptance', async () => {
      const intent = await claimWorkflowStart(
        'pg-ack-agent',
        'pg-ack-agent',
        target,
        true,
        Date.now() + 15_000,
        transaction
      );
      const held = deferred();
      const release = deferred();
      const attempting = deferred();
      let ackPid = 0;
      let ackFinished = false;
      const holder = db.$transaction(
        async (tx) => {
          await lockAgentWorkflowGeneration(tx, intent.agentId);
          held.resolve();
          await release.promise;
        },
        { timeout: 10_000 }
      );
      let acknowledgement: Promise<void> | undefined;
      try {
        await held.promise;
        const observed: AdmissionTransaction = (fn) =>
          db.$transaction(async (tx) => {
            ackPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
            attempting.resolve();
            return fn(tx);
          });
        acknowledgement = acknowledgeWorkflowStart(
          intent,
          { workflowId: intent.workflowId, firstExecutionRunId: 'pg-native-first-run' },
          Date.now() + 15_000,
          observed
        );
        void acknowledgement.then(
          () => {
            ackFinished = true;
          },
          () => {
            ackFinished = true;
          }
        );
        await attempting.promise;
        assert.equal(
          await waiting(ackPid, () => ackFinished),
          true,
          'ACK changed admission membership without waiting for the terminal generation lock'
        );
      } finally {
        release.resolve();
        await holder;
        await acknowledgement;
      }
      const saved = await db.toolSideEffect.findUniqueOrThrow({
        where: {
          operationKey: `agent-queue-start:${intent.id}`,
        },
      });
      assert.equal(saved.status, 'COMPLETED');
    });
    await test('per-agent membership uses its existing externalId index among ten thousand real rows', async () => {
      for (let start = 0; start < 10_000; start += 1000) {
        await db.toolSideEffect.createMany({
          data: Array.from({ length: 1000 }, (_, offset) => {
            const id = start + offset;
            const agentId = `pg-index-${id}`;
            return {
              operationKey: `pg-index-member-${id}`,
              operationType: 'AGENT_QUEUE_START',
              status: 'COMPLETED',
              externalId: agentId,
              request: {
                version: 1,
                id: `index-${id}`,
                agentId,
                workflowId: agentId,
                queue: target,
                requestedQueue: target,
                incarnation: schema,
                rejectDuplicate: true,
                wireCoverage: 'IMMUTABLE_ID',
                accepted: { workflowId: agentId, firstExecutionRunId: `run-${id}` },
              },
            };
          }),
        });
      }
      await db.$executeRawUnsafe(`ANALYZE "${schema}"."ToolSideEffect"`);
      captureMembership = true;
      const membership = await workflowStartMembership('pg-index-8750', undefined, db);
      captureMembership = false;
      const rows = JSON.parse(membership) as { request: { agentId: string } }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].request.agentId, 'pg-index-8750');
      assert(capturedQuery, 'actual Prisma membership query must be observed');
      // Query-event JSON omits native bind types. Ask Postgres to infer them
      // from the actual statement, then retain those types when replaying its
      // plan through Prisma's raw-query transport (which otherwise binds JSON
      // strings as text).
      const query = capturedQuery;
      const explained = await db.$transaction(async (tx) => {
        const statement = `membership_${schema}`;
        await tx.$executeRawUnsafe(`PREPARE "${statement}" AS ${query.query}`);
        const types = await tx.$queryRaw<{ type: string }[]>`
          SELECT format_type(p.oid::oid, NULL) AS type
          FROM pg_prepared_statements AS s,
               unnest(s.parameter_types) WITH ORDINALITY AS p(oid, position)
          WHERE s.name = ${statement} ORDER BY p.position
        `;
        await tx.$executeRawUnsafe(`DEALLOCATE "${statement}"`);
        for (const entry of types) {
          assert.match(entry.type, /^(text|integer|bigint|boolean|jsonb|json|text\[\])$/);
        }
        const typed = query.query.replace(
          /\$(\d+)/g,
          (_, index: string) => `$${index}::${types[Number(index) - 1].type}`
        );
        const values = JSON.parse(query.params) as unknown[];
        types.forEach((entry, index) => {
          if (entry.type === 'jsonb' || entry.type === 'json') {
            values[index] = JSON.stringify(values[index]);
          }
        });
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${typed}`,
          ...values
        );
      });
      const indexes: string[] = [];
      const walk = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === 'Index Name' && typeof child === 'string') indexes.push(child);
          walk(child);
        }
      };
      walk(explained);
      assert(
        indexes.includes('ToolSideEffect_externalId_idx'),
        `per-agent poll scanned the fleet journal instead of its existing index; indexes=${JSON.stringify(indexes)}`
      );
    });
  } finally {
    // Only this generated schema is removed; no shared fixture/pointer is touched.
    assert.match(schema, /^queue_admission_pg_[a-f0-9]+$/);
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await defaultClient.$disconnect();
  }
  finish();
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exitCode = 1;
});
