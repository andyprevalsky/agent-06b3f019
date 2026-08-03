#!/usr/bin/env tsx

import { Prisma, PrismaClient } from '@prisma/client';
import pLimit from 'p-limit';

import { buildArchivedRootCostTelemetry } from '../src/domains/admin-health/costTelemetry';
import { decryptAndValidateArtifact, readArchivedArtifact } from '../src/providers/traceArchive';
import { listArchiveBundleIds } from '../src/providers/traceArchiveAudit';

const prisma = new PrismaClient();
const LOOKUP_CHUNK_SIZE = 500;
const READ_CONCURRENCY = 10;
const END_FIXTURE_PATH = 'db/end.fixture.json.gz.enc';

interface GoalHistoryTarget {
  id: string;
  originalAgentId: string;
  costCapturedAt: Date | null;
}

function parseArgs(): { write: boolean; force: boolean } {
  const args = new Set(process.argv.slice(2));
  return { write: args.has('--write'), force: args.has('--force') };
}

async function findTargets(bundleIds: string[]): Promise<GoalHistoryTarget[]> {
  const targets: GoalHistoryTarget[] = [];
  for (let offset = 0; offset < bundleIds.length; offset += LOOKUP_CHUNK_SIZE) {
    targets.push(
      ...(await prisma.goalHistory.findMany({
        where: {
          depth: 0,
          originalAgentId: { in: bundleIds.slice(offset, offset + LOOKUP_CHUNK_SIZE) },
        },
        select: { id: true, originalAgentId: true, costCapturedAt: true },
      }))
    );
  }
  return targets;
}

async function readEndFixture(rootAgentId: string): Promise<unknown | null> {
  const stored = await readArchivedArtifact({ rootAgentId, objectPath: END_FIXTURE_PATH });
  if (stored === null) return null;
  return JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as unknown;
}

async function main(): Promise<void> {
  const { write, force } = parseArgs();
  const bundleIds = await listArchiveBundleIds();
  const allTargets = await findTargets(bundleIds);
  const targets = force
    ? allTargets
    : allTargets.filter((target) => target.costCapturedAt === null);
  const stats = {
    bundles: bundleIds.length,
    matchingRootHistory: allTargets.length,
    inspected: targets.length,
    fixturesMissing: 0,
    realRuns: 0,
    chatOnly: 0,
    simulated: 0,
    updated: 0,
    failures: 0,
  };
  const limit = pLimit(READ_CONCURRENCY);
  await Promise.all(
    targets.map((target) =>
      limit(async () => {
        try {
          const fixture = await readEndFixture(target.originalAgentId);
          if (fixture === null) {
            stats.fixturesMissing += 1;
            return;
          }
          const archived = buildArchivedRootCostTelemetry(target.originalAgentId, fixture);
          if (archived === null) {
            stats.failures += 1;
            return;
          }
          const { worldModelMode, telemetry } = archived;
          if (worldModelMode !== 'real') {
            stats.simulated += 1;
            if (write) {
              await prisma.goalHistory.update({
                where: { id: target.id },
                data: { worldModelMode, wasAgentRun: false, costCapturedAt: new Date() },
              });
              stats.updated += 1;
            }
            return;
          }
          if (telemetry === null) stats.chatOnly += 1;
          else stats.realRuns += 1;
          if (!write) return;
          await prisma.goalHistory.update({
            where: { id: target.id },
            data: {
              worldModelMode,
              wasAgentRun: telemetry !== null,
              costCapturedAt: new Date(),
              ...(telemetry === null
                ? {}
                : { costTelemetry: telemetry as unknown as Prisma.InputJsonValue }),
            },
          });
          stats.updated += 1;
        } catch {
          stats.failures += 1;
        }
      })
    )
  );
  console.log(JSON.stringify({ mode: write ? 'write' : 'dry-run', ...stats }));
  if (stats.failures > 0) process.exitCode = 1;
}

main()
  .finally(() => prisma.$disconnect())
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
