import { splitStatements } from '../../providers/schemaDrift/migrationObjects';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import type { Case } from './iphone-control.cases';
import { freshSetup } from './iphone-control.setup-fixtures';
export const messageQueueCases: Case[] = [
  [
    'logical task allows one concurrent unresolved binding and retires only undispatched expiry',
    async (h) => {
      const f = await freshSetup(h);
      const api = async (path: string, body: unknown) => {
        const response = await fetch(`${h.base}/api/imessage${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.BACKEND_API_KEY ?? '',
            'X-User-Id': f.userId,
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
      };
      const create = () =>
        api('/queue', {
          user_id: f.userId,
          agent_id: f.agentId,
          phone_number: '+15555550123',
          message: 'Independent approved intent',
          idempotency_key: randomUUID(),
        });
      const first = await create(),
        second = await create();
      const bind = (id: string) =>
        api(`/queue/${id}/phone-bind`, { user_id: f.userId, browser_task_id: f.taskId });
      const ids = [first.data.queue_id as string, second.data.queue_id as string];
      const concurrent = await Promise.all(ids.map(bind));
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      const winner = ids[concurrent.findIndex((r) => r.status === 200)]!;
      const pending = ids.find((id) => id !== winner)!;
      await prisma.imessageQueue.update({
        where: { id: winner },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      assert.equal((await bind(pending)).status, 200, 'Expired undispatched intent cannot retire');
      const retired = await prisma.imessageQueue.findUniqueOrThrow({ where: { id: winner } });
      assert.ok(retired.failedAt);
      assert.equal(retired.phoneBrowserTaskId, f.taskId, 'Expiry erased historical task');
      await prisma.imessageQueue.update({
        where: { id: pending },
        data: {
          dispatchedAt: new Date(),
          expiresAt: new Date(Date.now() - 1000),
          lastError: 'phone_message_outcome_unknown',
        },
      });
      const third = await create();
      assert.equal(
        (await bind(third.data.queue_id as string)).status,
        409,
        'Expired dispatched UNKNOWN lost its fence'
      );
      assert.equal(
        (await prisma.imessageQueue.findUniqueOrThrow({ where: { id: pending } })).failedAt,
        null
      );
    },
  ],

  [
    'message partial-index migration preserves historical task bindings and enforces one unresolved intent',
    async () => {
      const migrations = [
        '20261105233000_cloud_message_unresolved_task',
        '20261105233001_cloud_message_drop_historical_unique',
        '20261105233002_cloud_message_task_history_index',
      ];
      const operations = [
        'CREATE UNIQUE INDEX CONCURRENTLY',
        'DROP INDEX CONCURRENTLY',
        'CREATE INDEX CONCURRENTLY',
      ];
      const sql = migrations.map((name, index) => {
        const migration = readFileSync(
          path.resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
          'utf8'
        );
        const statements = splitStatements(migration);
        assert.equal(statements.length, 1, 'Concurrent migration must have one statement');
        assert.ok(statements[0]?.startsWith(operations[index]!));
        assert.equal(
          /\bIF (NOT )?EXISTS\b/.test(statements[0]!),
          false,
          'Production retry must not skip invalid indexes'
        );
        return migration;
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "ImessageQueue" ("phoneBrowserTaskId" TEXT, "transport" TEXT, "sentAt" TIMESTAMPTZ, "failedAt" TIMESTAMPTZ) ON COMMIT DROP'
        );
        await tx.$executeRawUnsafe(
          'CREATE UNIQUE INDEX "ImessageQueue_phoneBrowserTaskId_key" ON "ImessageQueue"("phoneBrowserTaskId")'
        );
        for (let pass = 0; pass < 2; pass++)
          for (const migration of sql)
            for (const statement of splitStatements(
              migration
                .replace(/(CREATE(?: UNIQUE)? INDEX) CONCURRENTLY /g, '$1 IF NOT EXISTS ')
                .replace(/DROP INDEX CONCURRENTLY /g, 'DROP INDEX IF EXISTS ')
            ))
              await tx.$executeRawUnsafe(statement);
        await tx.$executeRawUnsafe(`DO $test$ BEGIN
        INSERT INTO "ImessageQueue" VALUES ('same-task','phone_harness',NULL,NULL);
        BEGIN
          INSERT INTO "ImessageQueue" VALUES ('same-task','phone_harness',NULL,NULL);
          RAISE EXCEPTION 'Concurrent unresolved task intent accepted';
        EXCEPTION WHEN unique_violation THEN NULL; END;
        UPDATE "ImessageQueue" SET "sentAt"=clock_timestamp() WHERE "phoneBrowserTaskId"='same-task';
        INSERT INTO "ImessageQueue" VALUES ('same-task','phone_harness',NULL,NULL);
        INSERT INTO "ImessageQueue" VALUES ('same-task','mac',NULL,NULL);
        INSERT INTO "ImessageQueue" VALUES ('same-task','mac',NULL,NULL);
      END $test$;`);
      });
    },
  ],

  [
    'cloud queue transport and immutable task binding exclude Mac relay',
    async (h) => {
      const f = await freshSetup(h);
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(`${h.base}/api/imessage${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': process.env.BACKEND_API_KEY ?? '',
            'X-User-Id': f.userId,
            'X-CloudBench-iMessage-Relay': 'v1',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          data:
            response.headers.get('content-type')?.includes('application/json') === true
              ? ((await response.json()) as Record<string, unknown>)
              : {},
        };
      };
      const body = {
        user_id: f.userId,
        agent_id: f.agentId,
        phone_number: '+15555550123',
        message: 'Approved queue route body',
        idempotency_key: randomUUID(),
      };
      const deviceDelegate = prisma.iPhoneDevice;
      const findDevice = deviceDelegate.findUnique;
      deviceDelegate.findUnique = (async () => {
        throw new Error('synthetic cloud DB unavailable');
      }) as typeof findDevice;
      try {
        const failed = await api('/queue', body);
        assert.equal(
          failed.status,
          500,
          'Cloud eligibility infrastructure failure must not become validation error'
        );
        assert.equal(
          failed.data.error,
          'Failed to queue iMessage',
          'Infrastructure details escaped into client error'
        );
      } finally {
        deviceDelegate.findUnique = findDevice;
      }
      const created = await api('/queue', body);
      assert.equal(created.status, 200);
      assert.equal(created.data.provider, 'phone_harness');
      const id = created.data.queue_id as string;
      assert.equal((await api('/queue', { ...body, message: 'Changed intent' })).status, 409);
      assert.equal(
        (await api(`/queue/${id}/phone-bind`, { user_id: f.userId, browser_task_id: randomUUID() }))
          .status,
        409
      );
      const failedTransaction = mock.method(prisma, '$transaction', async () => {
        throw new Error('fixture database unavailable');
      });
      try {
        assert.equal(
          (await api(`/queue/${id}/phone-bind`, { user_id: f.userId, browser_task_id: f.taskId }))
            .status,
          500,
          'Database infrastructure failure must not be reported as a task-binding conflict'
        );
      } finally {
        failedTransaction.mock.restore();
      }
      const bound = await api(`/queue/${id}/phone-bind`, {
        user_id: f.userId,
        browser_task_id: f.taskId,
      });
      assert.equal(bound.status, 200);
      const second = await api('/queue', { ...body, idempotency_key: randomUUID() });
      assert.equal(
        (
          await api(`/queue/${second.data.queue_id as string}/phone-bind`, {
            user_id: f.userId,
            browser_task_id: f.taskId,
          })
        ).status,
        409
      );
      assert.equal((await api('/queue/pop')).data.message, null, 'Mac relay consumed cloud queue');
      const old = process.env.CLOUD_IPHONE_ENABLED;
      process.env.CLOUD_IPHONE_ENABLED = '0';
      try {
        const mac = await api('/queue', { ...body, idempotency_key: randomUUID() });
        assert.equal(mac.status, 200);
        assert.equal(Object.hasOwn(mac.data, 'provider'), false);
        assert.equal(
          (
            await prisma.imessageQueue.findUniqueOrThrow({
              where: { id: mac.data.queue_id as string },
            })
          ).transport,
          'mac'
        );
      } finally {
        process.env.CLOUD_IPHONE_ENABLED = old;
      }
    },
  ],
];
