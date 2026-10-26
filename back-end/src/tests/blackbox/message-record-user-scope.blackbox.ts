#!/usr/bin/env tsx
/**
 * Black-box contract: per-user MessageRecord reads cost O(that user's rows),
 * never O(every user's rows).
 *
 * Production evidence (2026-10-26, pg_stat_statements + EXPLAIN): the data
 * summary's oldest/newest-message lookups and people "recent messages" walked
 * the GLOBAL `MessageRecord(timestamp)` index and joined Person per row until
 * enough of the caller's rows appeared — 34,690 foreign rows read to return 200
 * for a 24k-message user, 208 ms mean / 6 s max over 6,342 calls. Grep counted
 * and paged a regex over every one of the caller's messages (1.1-1.5 s mean).
 *
 * This suite seeds a "whale" user whose messages surround the target user's in
 * time, runs each real repo function against the local database, captures the
 * SQL it actually issued, and EXPLAIN ANALYZEs it. The assertion is on rows
 * read from MessageRecord (deterministic), not on wall-clock time.
 *
 * Usage (local DB only):
 *   bash scripts/run-blackbox-tests.sh message-record-user-scope
 */

import './assertLocalDatabase';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MessageChannel, Prisma, PrismaClient } from '@prisma/client';
import { config } from 'dotenv';

config();

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

const captured: CapturedQuery[] = [];
const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
client.$on('query', (event) => {
  captured.push({ sql: event.query, params: JSON.parse(event.params) as unknown[] });
});
// Repo modules resolve the shared client from `global.prisma` outside
// production, so installing the logging client first makes them issue every
// query through it.
(global as unknown as { prisma: PrismaClient }).prisma = client;

const WHALE_PERSONS = 10;
const WHALE_MESSAGES_PER_PERSON = 10_000;
// A mid-size user (a few percent of all rows, like production's 24k-message
// user beside a 209k-message one) for the ordered/aggregate reads, and a heavy
// user for grep, whose cost must follow the matches rather than the history.
const TARGET_PERSONS = 20;
const TARGET_MESSAGES_PER_PERSON = 100;
const TARGET_TOTAL = TARGET_PERSONS * TARGET_MESSAGES_PER_PERSON;
const HEAVY_PERSONS = 20;
const HEAVY_MESSAGES_PER_PERSON = 1_000;
const NEEDLE = `zq${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const NEEDLE_MATCHES = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
// Whale history surrounds the target's in time, so a walk of the global
// timestamp index in either direction meets whale rows before target rows.
const WHALE_OLD_START = Date.UTC(2019, 0, 1);
const TARGET_START = Date.UTC(2022, 0, 1);
const HEAVY_START = Date.UTC(2023, 0, 1);
const WHALE_NEW_START = Date.UTC(2025, 0, 1);

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Inline captured bind values so EXPLAIN plans exactly the issued statement. */
function inlineParams(query: CapturedQuery): string {
  return query.sql.replace(/\$(\d+)/g, (_match, index: string) =>
    literal(query.params[Number(index) - 1])
  );
}

interface PlanNode {
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
}

/** Every MessageRecord tuple a plan touched: returned plus filtered away. */
function messageRecordRowsRead(node: PlanNode): number {
  let total = 0;
  if (node['Relation Name'] === 'MessageRecord') {
    const loops = node['Actual Loops'] ?? 1;
    total +=
      ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * loops +
      (node['Rows Removed by Index Recheck'] ?? 0);
  }
  for (const child of node.Plans ?? []) total += messageRecordRowsRead(child);
  return total;
}

async function rowsReadBy(label: string, run: () => Promise<unknown>): Promise<number> {
  captured.length = 0;
  await run();
  const statements = captured.filter((query) => /"MessageRecord"/.test(query.sql));
  if (statements.length === 0) throw new Error(`${label}: issued no MessageRecord query`);
  let total = 0;
  for (const statement of statements) {
    const rows = await client.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${inlineParams(statement)}`
    );
    total += messageRecordRowsRead(rows[0]['QUERY PLAN'][0].Plan);
  }
  return total;
}

async function createPeople(userId: string, count: number, prefix: string): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const person = await client.person.create({
      data: { userId, firstName: prefix, lastName: `${index}`, phoneNumber: `+1555${index}` },
      select: { id: true },
    });
    ids.push(person.id);
  }
  return ids;
}

async function insertMessages(rows: Prisma.MessageRecordCreateManyInput[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 5_000) {
    await client.messageRecord.createMany({ data: rows.slice(start, start + 5_000) });
  }
}

function messageRow(
  userId: string,
  personId: string,
  timestamp: number,
  message: string,
  inbound: boolean
): Prisma.MessageRecordCreateManyInput {
  return {
    personId,
    userId,
    channel: MessageChannel.IMESSAGE,
    from: inbound ? '+15550000000' : 'me',
    to: inbound ? 'me' : '+15550000000',
    timestamp: new Date(timestamp),
    message,
  };
}

async function seedUser(
  userId: string,
  persons: number,
  perPerson: number,
  row: (ordinal: number) => { at: number; text: string }
): Promise<void> {
  const people = await createPeople(userId, persons, userId);
  const rows: Prisma.MessageRecordCreateManyInput[] = [];
  people.forEach((personId, personIndex) => {
    for (let index = 0; index < perPerson; index++) {
      const { at, text } = row(personIndex * perPerson + index);
      rows.push(messageRow(userId, personId, at, text, index % 3 === 0));
    }
  });
  await insertMessages(rows);
}

async function seed(users: { target: string; heavy: string; whale: string }): Promise<void> {
  await client.user.createMany({
    data: Object.values(users).map((userId) => ({ userId, isAnonymous: true })),
  });
  // Whale rows alternate between before and after everyone else's history.
  // Set-based insert: the whale only needs to exist, not to exercise Prisma.
  const whalePeople = await createPeople(users.whale, WHALE_PERSONS, users.whale);
  await client.$executeRaw`
    INSERT INTO "MessageRecord" (id, "personId", "userId", channel, "from", "to", timestamp, message)
    SELECT gen_random_uuid()::text, (${whalePeople}::text[])[1 + g % ${WHALE_PERSONS}], ${users.whale},
           'IMESSAGE', 'me', '+15550000000',
           to_timestamp((CASE WHEN g % 2 = 0 THEN ${WHALE_OLD_START}::bigint ELSE ${WHALE_NEW_START}::bigint END
                         + g * 60000::bigint) / 1000.0),
           'whale chatter ' || g
    FROM generate_series(1, ${WHALE_PERSONS * WHALE_MESSAGES_PER_PERSON}) g`;
  await seedUser(users.target, TARGET_PERSONS, TARGET_MESSAGES_PER_PERSON, (ordinal) => ({
    at: TARGET_START + ordinal * 3_600_000,
    text: `target note ${ordinal}`,
  }));
  await seedUser(users.heavy, HEAVY_PERSONS, HEAVY_MESSAGES_PER_PERSON, (ordinal) => ({
    at: HEAVY_START + ordinal * 60_000,
    text: ordinal < NEEDLE_MATCHES ? `meet at the ${NEEDLE} cafe` : `heavy note ${ordinal}`,
  }));

  // Ship-time indexes that Prisma cannot model are applied from the exact
  // migration files, as `prisma migrate deploy` does in production.
  for (const migration of ['20261026170000_message_record_message_trgm']) {
    const path = resolve(__dirname, '../../../prisma/migrations', migration, 'migration.sql');
    const sql = readFileSync(path, 'utf8');
    await client.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.$executeRawUnsafe(sql);
  }
  await client.$executeRawUnsafe('ANALYZE "MessageRecord"');
  await client.$executeRawUnsafe('ANALYZE "Person"');
}

async function cleanup(userIds: string[]): Promise<void> {
  const people = await client.person.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  await client.messageRecord.deleteMany({ where: { personId: { in: people.map((p) => p.id) } } });
  await client.person.deleteMany({ where: { userId: { in: userIds } } });
  await client.user.deleteMany({ where: { userId: { in: userIds } } });
}

/**
 * Trace-archive fixtures captured before MessageRecord.userId existed still
 * restore, with each message owned by the fixture's user.
 */
async function legacyFixtureRestoreFailure(): Promise<string | null> {
  const { restoreFixture } = await import('../../providers/traceArchiveFixture');
  const userId = `msg-scope-legacy-${randomUUID()}`;
  const personId = randomUUID();
  const messageId = randomUUID();
  await client.user.create({ data: { userId, isAnonymous: true } });
  try {
    const fixture = {
      schema_version: 1,
      kind: 'scoped-db-fixture',
      phase: 'end',
      captured_at: new Date().toISOString(),
      base_image: 'legacy',
      root_agent_id: randomUUID(),
      user_id: userId,
      agent_ids: [],
      table_order: ['Person', 'MessageRecord'],
      restore: {},
      rows: {
        Person: [{ id: personId, userId, firstName: 'Legacy', lastName: 'Fixture' }],
        MessageRecord: [
          {
            id: messageId,
            personId,
            channel: 'IMESSAGE',
            from: 'me',
            to: '+15550000000',
            timestamp: new Date(TARGET_START).toISOString(),
            message: 'archived before userId',
          },
        ],
      },
    } as unknown as Parameters<typeof restoreFixture>[0];
    await restoreFixture(fixture);
    const restored = await client.messageRecord.findUnique({ where: { id: messageId } });
    return restored?.userId === userId
      ? null
      : `legacy fixture restored MessageRecord owner ${String(restored?.userId)}, expected ${userId}`;
  } finally {
    await cleanup([userId]);
  }
}

async function main(): Promise<void> {
  const peopleRepo = await import('../../domains/people/repo');
  const dataRepo = await import('../../domains/data/repo');
  const grepRepo = await import('../../domains/data/grepRepo');
  const contextRepo = await import('../../domains/data/messageContextRepo');
  const imessageRepo = await import('../../domains/imessage/repo');

  const targetUserId = `msg-scope-target-${randomUUID()}`;
  const whaleUserId = `msg-scope-whale-${randomUUID()}`;
  const heavyUserId = `msg-scope-heavy-${randomUUID()}`;
  const failures: string[] = [];
  try {
    await seed({ target: targetUserId, heavy: heavyUserId, whale: whaleUserId });

    const userBound: Array<[string, () => Promise<unknown>]> = [
      ['people recent messages', () => peopleRepo.findRecentMessages(targetUserId, undefined, 200)],
      ['data summary count', () => dataRepo.countAllMessages(targetUserId)],
      ['data summary channels', () => dataRepo.getChannelCounts(targetUserId)],
      ['data summary oldest', () => dataRepo.getOldestMessage(targetUserId)],
      ['data summary newest', () => dataRepo.getNewestMessage(targetUserId)],
      [
        'imessage recent inbound',
        () =>
          imessageRepo.findRecentInboundMessages({
            userId: targetUserId,
            since: new Date(TARGET_START - DAY_MS),
            limit: 20,
          }),
      ],
    ];
    for (const [label, run] of userBound) {
      const read = await rowsReadBy(label, run);
      const ok = read <= TARGET_TOTAL;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${label}: read ${read} MessageRecord rows (target owns ${TARGET_TOTAL})`
      );
      if (!ok) failures.push(`${label} read ${read} rows; the user owns only ${TARGET_TOTAL}`);
    }

    // Grep must be driven by the pattern, not by a scan of every message the
    // user owns: a selective literal reads a small multiple of its matches.
    const grepBudget = NEEDLE_MATCHES * 10;
    const grepCases: Array<[string, () => Promise<unknown>]> = [
      [
        'grep count',
        () =>
          grepRepo.countMessageGrepRows({
            userId: heavyUserId,
            pattern: NEEDLE,
            caseInsensitive: true,
          }),
      ],
      [
        'grep page',
        () =>
          contextRepo.searchConversationMatchRows({
            userId: heavyUserId,
            pattern: NEEDLE,
            caseInsensitive: true,
            limit: 20,
            offset: 0,
          }),
      ],
    ];
    for (const [label, run] of grepCases) {
      const read = await rowsReadBy(label, run);
      const ok = read <= grepBudget;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} ${label}: read ${read} MessageRecord rows for ${NEEDLE_MATCHES} matches`
      );
      if (!ok)
        failures.push(
          `${label} read ${read} rows for ${NEEDLE_MATCHES} matches (budget ${grepBudget})`
        );
    }

    // Results stay correct and scoped to the caller.
    const recent = await peopleRepo.findRecentMessages(targetUserId, undefined, 200);
    if (recent.length !== 200 || recent.some((row) => row.message.startsWith('whale'))) {
      failures.push(`recent messages returned ${recent.length} rows or leaked whale rows`);
    }
    const count = await grepRepo.countMessageGrepRows({
      userId: heavyUserId,
      pattern: NEEDLE,
      caseInsensitive: true,
    });
    if (count !== NEEDLE_MATCHES) failures.push(`grep count ${count}, expected ${NEEDLE_MATCHES}`);
    const whaleCount = await grepRepo.countMessageGrepRows({
      userId: whaleUserId,
      pattern: NEEDLE,
      caseInsensitive: true,
    });
    if (whaleCount !== 0)
      failures.push(`grep leaked ${whaleCount} heavy-user rows to another user`);

    const legacyFailure = await legacyFixtureRestoreFailure();
    if (legacyFailure !== null) failures.push(legacyFailure);
  } finally {
    await cleanup([targetUserId, heavyUserId, whaleUserId]);
    await client.$disconnect();
  }

  if (failures.length > 0) {
    console.error(`FAIL message-record-user-scope:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log('PASS message-record-user-scope: every per-user MessageRecord read is user-bounded');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
