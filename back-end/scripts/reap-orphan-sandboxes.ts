#!/usr/bin/env tsx
/**
 * One-time reaper for unreferenced paused E2B sandboxes. DRY-RUN BY DEFAULT.
 *
 *   E2B list ─┐
 *             ├─► decideOrphan (providers/codeSessions/orphanSandboxEligibility.ts)
 *   prod refs ┘        │ receipt (JSON lines, /var/tmp) written BEFORE any kill
 *                      └─► --execute: kill eligible, concurrency <= 6, 429 backoff
 *
 * Prod references are read ONLY via DIRECT_URL inside a READ ONLY transaction
 * that is always rolled back. Snapshots/templates are never touched.
 *
 *   npx tsx scripts/reap-orphan-sandboxes.ts                 # dry run
 *   npx tsx scripts/reap-orphan-sandboxes.ts --execute [--expect-eligible N] [--receipt PATH]
 *   flags: --untagged-hours 24  --host-tagged-hours 72
 *
 * --execute without --expect-eligible is refused; with it, the run aborts when
 * the live eligible set differs from N by more than 5%.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { Sandbox } from 'e2b';
import {
  decideOrphan,
  type OrphanBucket,
  type OrphanCandidate,
  type OrphanDecision,
  type ProdReferences,
} from '../src/providers/codeSessions/orphanSandboxEligibility';

const CONCURRENCY = 6;
const MAX_CONSECUTIVE_ERRORS = 3;
const EXPECT_TOLERANCE = 0.05;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readProdReferences(): Promise<ProdReferences> {
  const url = process.env.DIRECT_URL;
  if (!url) throw new Error('DIRECT_URL is not set (prod references need the 5432 connection)');
  const prisma = new PrismaClient({ datasourceUrl: url });
  const ROLLBACK = new Error('rollback');
  const refs: ProdReferences = {
    sandboxIds: new Set(),
    codeSessionIds: new Set(),
    agentIds: new Set(),
  };
  try {
    await prisma
      .$transaction(
        async (tx) => {
          // First statement of the transaction: nothing here can write.
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '120s'");
          const ids = async (sql: string) =>
            (await tx.$queryRawUnsafe<Array<{ v: string | null }>>(sql))
              .map((r) => r.v)
              .filter((v): v is string => !!v);
          for (const v of await ids('SELECT DISTINCT "sandboxId" AS v FROM "ClaudeCodeSession"'))
            refs.sandboxIds.add(v);
          for (const v of await ids('SELECT DISTINCT "sandboxId" AS v FROM "CodeSession"'))
            refs.sandboxIds.add(v);
          for (const v of await ids(
            'SELECT DISTINCT "sandboxId" AS v FROM "ProjectMaintenanceRun"'
          ))
            refs.sandboxIds.add(v);
          for (const v of await ids('SELECT id AS v FROM "CodeSession"'))
            refs.codeSessionIds.add(v);
          for (const v of await ids(
            'SELECT "codeSessionId" AS v FROM "ClaudeCodeSession" GROUP BY 1'
          ))
            refs.codeSessionIds.add(v);
          for (const v of await ids('SELECT DISTINCT "ownerAgentId" AS v FROM "CodeSession"'))
            refs.agentIds.add(v);
          for (const v of await ids('SELECT DISTINCT "rootAgentId" AS v FROM "CodeSession"'))
            refs.agentIds.add(v);
          for (const v of await ids('SELECT DISTINCT "agentId" AS v FROM "ClaudeCodeSession"'))
            refs.agentIds.add(v);
          throw ROLLBACK; // always roll back
        },
        { timeout: 180_000, maxWait: 30_000 }
      )
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  } finally {
    await prisma.$disconnect();
  }
  return refs;
}

async function listAll(): Promise<OrphanCandidate[]> {
  const out: OrphanCandidate[] = [];
  const paginator = Sandbox.list({
    apiKey: process.env.E2B_API_KEY,
    query: { state: ['running', 'paused'] },
    limit: 100,
  });
  do {
    for (const item of await paginator.nextItems()) {
      out.push({
        sandboxId: item.sandboxId,
        state: item.state,
        startedAt: item.startedAt,
        templateId: item.templateId,
        metadata: item.metadata ?? {},
      });
    }
  } while (paginator.hasNext);
  return out;
}

async function killWithBackoff(sandboxId: string): Promise<'killed' | 'gone'> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const ok = await Sandbox.kill(sandboxId, { apiKey: process.env.E2B_API_KEY });
      return ok === false ? 'gone' : 'killed';
    } catch (error) {
      const msg = error instanceof Error ? `${error.name} ${error.message}` : String(error);
      if (/429|rate limit|RateLimit/i.test(msg) && attempt < 6) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      throw error;
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is not set');
  const execute = has('execute');
  const criteria = {
    untaggedMinAgeMs: Number(flag('untagged-hours') ?? 24) * 3600_000,
    hostTaggedMinAgeMs: Number(flag('host-tagged-hours') ?? 72) * 3600_000,
  };
  const expect = flag('expect-eligible');
  if (execute && expect === undefined) throw new Error('--execute requires --expect-eligible N');
  const now = new Date();
  const refs = await readProdReferences();
  const listed = await listAll();
  const decisions = listed.map((s) => ({ s, d: decideOrphan(s, refs, now, criteria) }));
  const buckets = new Map<OrphanBucket, string[]>();
  for (const { s, d } of decisions)
    buckets.set(d.bucket, [...(buckets.get(d.bucket) ?? []), s.sandboxId]);
  const eligible = decisions.filter(({ d }) => d.eligible);

  const receipt =
    flag('receipt') ??
    `/var/tmp/reap-orphan-sandboxes-${now.toISOString().replace(/[:.]/g, '')}.jsonl`;
  const row = (s: OrphanCandidate, d: OrphanDecision, killedAt: string | null) =>
    JSON.stringify({
      id: s.sandboxId,
      templateId: s.templateId ?? null,
      state: s.state,
      startedAt: s.startedAt.toISOString(),
      metadata: s.metadata,
      decision: d.bucket,
      eligible: d.eligible,
      reason: d.reason,
      killedAt,
    });
  // Written complete before any kill (kills append to `<receipt>.kills`).
  writeFileSync(receipt, decisions.map(({ s, d }) => row(s, d, null)).join('\n') + '\n', {
    mode: 0o600,
  });
  const hash = createHash('sha256').update(readFileSync(receipt)).digest('hex').slice(0, 16);

  console.log(
    `mode=${execute ? 'EXECUTE' : 'DRY-RUN'} listed=${listed.length} receipt=${receipt} sha256=${hash}`
  );
  for (const [bucket, ids] of [...buckets.entries()].sort()) {
    console.log(`${bucket}: ${ids.length}  sample: ${ids.slice(0, 8).join(' ')}`);
  }
  console.log(
    `eligible=${eligible.length} totalPaused=${listed.filter((s) => s.state === 'paused').length}`
  );
  if (!execute) return;

  const n = Number(expect);
  if (!Number.isFinite(n) || Math.abs(eligible.length - n) > Math.max(1, n * EXPECT_TOLERANCE)) {
    throw new Error(
      `live eligible=${eligible.length} differs from reviewed ${expect} by more than 5%; aborting`
    );
  }
  let killed = 0;
  let failed = 0;
  let consecutive = 0;
  let aborted = false;
  const queue = [...eligible];
  const worker = async () => {
    for (let item = queue.shift(); item && !aborted; item = queue.shift()) {
      try {
        const result = await killWithBackoff(item.s.sandboxId);
        consecutive = 0;
        if (result === 'killed') killed += 1;
        appendFileSync(receipt + '.kills', row(item.s, item.d, new Date().toISOString()) + '\n', {
          mode: 0o600,
        });
      } catch (error) {
        failed += 1;
        consecutive += 1;
        console.error(
          `kill failed ${item.s.sandboxId}: ${error instanceof Error ? error.message : String(error)}`
        );
        if (consecutive >= MAX_CONSECUTIVE_ERRORS) aborted = true;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`killed=${killed} failed=${failed} aborted=${aborted} kill-receipt=${receipt}.kills`);
  const after = await listAll();
  const remaining = after.filter(
    (s) => decideOrphan(s, refs, new Date(), criteria).eligible
  ).length;
  console.log(
    `verify: remainingEligible=${remaining} totalPaused=${after.filter((s) => s.state === 'paused').length}`
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      `reap-orphan-sandboxes: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
