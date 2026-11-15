#!/usr/bin/env tsx
/**
 * Copy code-session checkpoints (CLI logs, manifests, worktree and repo
 * bundles) from Supabase Storage into the root agent's encrypted R2 trace
 * archive bundle, before session retirement or checkpoint pruning deletes them.
 *
 *   Supabase  user/<userId>/code-sessions/<id>/<seq>/<artifact>
 *      └──► R2 trace-archive/<rootAgentId>/code/<id>/<seq>/<artifact>.enc
 *
 * The same mirror the live checkpoint path uses (codeSessions/archiveMirror.ts):
 * every artifact is hash-checked against its checkpoint manifest first, the
 * manifest is archived last, and the root is the tree root (parentAgentId walk),
 * so a sub-agent's session lands in its root bundle (`nonRootSessions=` counts
 * sessions whose stored rootAgentId was not the tree root). A checkpoint whose archived
 * copy is already confirmed is skipped; writes are create-only, so reruns are
 * idempotent and never overwrite. Nothing is deleted from either store.
 *
 * Every seq that can still exist is scanned (checkpointSeqsToScan): from the
 * highest allocated seq down to 1. `--lookback N` caps the scan N below the top
 * but never skips the restore window under the latest committed seq.
 *
 *   npx tsx scripts/backfill-code-session-checkpoints.ts --dry-run
 *   npx tsx scripts/backfill-code-session-checkpoints.ts --apply [--session <id>]
 */
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pLimit from 'p-limit';

interface Args {
  apply: boolean;
  sessions: string[];
  lookback: number | undefined;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, sessions: [], lookback: undefined, concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--apply') args.apply = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--session') args.sessions.push(next());
    else if (arg === '--lookback') args.lookback = Number(next());
    else if (arg === '--concurrency') args.concurrency = Number(next());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

interface ManifestShape {
  artifacts: Record<string, { sha256: string; size: number }>;
}

/**
 * Sessions to scan: every one with an allocated checkpoint seq. A checkpoint whose
 * upload finished but whose commit failed leaves latestCheckpointSeq at 0 while
 * nextCheckpointSeq (always >= latestCheckpointSeq) has moved on.
 */
export function backfillSessionWhere(sessions: string[]): {
  nextCheckpointSeq: { gt: number };
  id?: { in: string[] };
  state?: { not: string };
} {
  return {
    nextCheckpointSeq: { gt: 0 },
    ...(sessions.length > 0 ? { id: { in: sessions } } : { state: { not: 'RETIRED' } }),
  };
}

/**
 * A checkpoint manifest whose artifact list can be trusted, else a throw: a
 * malformed manifest must fail the session, never confirm an archive that holds
 * only the manifest itself.
 */
export function parseCheckpointManifest(manifestBytes: Buffer): ManifestShape {
  const parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown;
  const artifacts =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { artifacts?: unknown }).artifacts
      : undefined;
  if (typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) {
    throw new Error('checkpoint manifest has no artifacts object');
  }
  for (const [name, meta] of Object.entries(artifacts)) {
    const { sha256, size } = (meta ?? {}) as { sha256?: unknown; size?: unknown };
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`checkpoint manifest artifact ${name} has no sha256`);
    }
    if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
      throw new Error(`checkpoint manifest artifact ${name} has no size`);
    }
  }
  return { artifacts: artifacts as ManifestShape['artifacts'] };
}

async function main(): Promise<void> {
  config(); // back-end/.env; loaded here so importing this module (tests) never reads prod credentials
  const args = parseArgs(process.argv.slice(2));
  const { prisma } = await import('../src/providers/database');
  const { checkpointKey, getCheckpointObject } =
    await import('../src/providers/codeSessions/artifactStore');
  const { MANIFEST_NAME } = await import('../src/providers/codeSessions/checkpoint');
  const { checkpointSeqsToScan } = await import('../src/providers/codeSessions/lifecycle');
  const { archiveTargetFor, checkpointArchiveConfirmed, mirrorCheckpointToArchive } =
    await import('../src/providers/codeSessions/archiveMirror');
  const { archiveEnabled } = await import('../src/providers/traceArchive');
  if (args.apply && !archiveEnabled()) throw new Error('trace archive is not enabled');

  const sessions = await prisma.codeSession.findMany({
    where: backfillSessionWhere(args.sessions),
    select: {
      id: true,
      userId: true,
      rootAgentId: true,
      latestCheckpointSeq: true,
      nextCheckpointSeq: true,
      lastActiveAt: true,
    },
    // Oldest activity first: those are the next to be retired.
    orderBy: { lastActiveAt: 'asc' },
  });
  process.stdout.write(`sessions=${sessions.length} apply=${args.apply}\n`);

  const limit = pLimit(args.concurrency);
  let failures = 0;
  let nonRootSessions = 0;
  await Promise.all(
    sessions.map((session) =>
      limit(async () => {
        const receipt = { archived: 0, existing: 0, confirmed: 0, bytes: 0, seqs: [] as number[] };
        let root = session.rootAgentId;
        try {
          const target = await archiveTargetFor(session);
          root = target.rootAgentId;
          if (root !== session.rootAgentId) {
            nonRootSessions += 1;
            process.stdout.write(
              `NONROOT ${session.id} stored=${session.rootAgentId} root=${root}\n`
            );
          }
          for (const seq of checkpointSeqsToScan(session, args.lookback)) {
            const manifestKey = checkpointKey(session.userId, session.id, seq, MANIFEST_NAME);
            const manifestBytes = await getCheckpointObject(manifestKey);
            if (manifestBytes === null) continue;
            receipt.seqs.push(seq);
            const manifest = parseCheckpointManifest(manifestBytes);
            if (args.apply) {
              if (await checkpointArchiveConfirmed({ target, seq, manifestBytes })) {
                receipt.confirmed += 1;
                continue;
              }
              const mirrored = await mirrorCheckpointToArchive({ target, seq, manifestBytes });
              if (!(await checkpointArchiveConfirmed({ target, seq, manifestBytes }))) {
                throw new Error(`seq ${seq} archive copy not confirmed after mirroring`);
              }
              receipt.archived += mirrored.archived;
              receipt.existing += mirrored.existing;
              receipt.bytes += mirrored.bytes;
              continue;
            }
            // Dry run: read and hash-check every artifact, write nothing.
            for (const [name, expected] of Object.entries(manifest.artifacts)) {
              const body = await getCheckpointObject(
                checkpointKey(session.userId, session.id, seq, name)
              );
              if (body === null) throw new Error(`seq ${seq} artifact ${name} missing`);
              const digest = createHash('sha256').update(body).digest('hex');
              if (digest !== expected.sha256 || body.length !== expected.size) {
                throw new Error(`seq ${seq} artifact ${name} failed integrity check`);
              }
              receipt.bytes += body.length;
            }
            receipt.bytes += manifestBytes.length;
          }
          process.stdout.write(
            `OK ${session.id} root=${root} lastActive=${session.lastActiveAt.toISOString()} seqs=${receipt.seqs.join(',') || '-'} archived=${receipt.archived} existing=${receipt.existing} confirmed=${receipt.confirmed} bytes=${receipt.bytes}\n`
          );
        } catch (error) {
          failures += 1;
          process.stdout.write(
            `FAIL ${session.id} root=${root} ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      })
    )
  );
  process.stdout.write(
    `DONE sessions=${sessions.length} failures=${failures} nonRootSessions=${nonRootSessions}\n`
  );
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
