#!/usr/bin/env tsx
/**
 * Copy code-session checkpoints (CLI logs, manifests, worktree and repo
 * bundles) from Supabase Storage into the root agent's encrypted R2 trace
 * archive bundle, before session retirement or checkpoint pruning deletes them.
 *
 *   Supabase  user/<userId>/code-sessions/<id>/<seq>/<artifact>
 *      └──► R2 trace-archive/<rootAgentId>/code/<id>/<seq>/<artifact>.enc
 *
 * Every artifact is hash-checked against its checkpoint manifest first; the
 * manifest is archived last. Writes are create-only, so reruns are idempotent
 * and never overwrite. Nothing is deleted from either store.
 *
 *   npx tsx scripts/backfill-code-session-checkpoints.ts --dry-run
 *   npx tsx scripts/backfill-code-session-checkpoints.ts --apply [--session <id>]
 */
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import pLimit from 'p-limit';

config();

interface Args {
  apply: boolean;
  sessions: string[];
  lookback: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, sessions: [], lookback: 12, concurrency: 4 };
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
  artifacts?: Record<string, { sha256: string; size: number }>;
}

function contentTypeFor(name: string): { contentType: string; compress: boolean | undefined } {
  if (name.endsWith('.json')) return { contentType: 'application/json', compress: true };
  if (name.endsWith('.jsonl')) return { contentType: 'application/x-ndjson', compress: true };
  if (name.endsWith('.gz')) return { contentType: 'application/gzip', compress: false };
  return { contentType: 'application/octet-stream', compress: undefined };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { prisma } = await import('../src/providers/database');
  const { checkpointKey, getCheckpointObject } = await import(
    '../src/providers/codeSessions/artifactStore'
  );
  const { MANIFEST_NAME } = await import('../src/providers/codeSessions/checkpoint');
  const { archiveBytes, archiveEnabled } = await import('../src/providers/traceArchive');
  if (args.apply && !archiveEnabled()) throw new Error('trace archive is not enabled');

  const sessions = await prisma.codeSession.findMany({
    where: {
      latestCheckpointSeq: { gt: 0 },
      ...(args.sessions.length > 0 ? { id: { in: args.sessions } } : { state: { not: 'RETIRED' } }),
    },
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
  await Promise.all(
    sessions.map((session) =>
      limit(async () => {
        const top = Math.max(session.latestCheckpointSeq, session.nextCheckpointSeq);
        const receipt = { archived: 0, existing: 0, bytes: 0, seqs: [] as number[] };
        try {
          for (let seq = top; seq >= Math.max(1, top - args.lookback); seq -= 1) {
            const manifestKey = checkpointKey(session.userId, session.id, seq, MANIFEST_NAME);
            const manifestRaw = await getCheckpointObject(manifestKey);
            if (manifestRaw === null) continue;
            const manifest = JSON.parse(manifestRaw.toString('utf8')) as ManifestShape;
            const entries = Object.entries(manifest.artifacts ?? {});
            const bodies: Array<[string, Buffer]> = [];
            for (const [name, expected] of entries) {
              const body = await getCheckpointObject(checkpointKey(session.userId, session.id, seq, name));
              if (body === null) throw new Error(`seq ${seq} artifact ${name} missing`);
              const digest = createHash('sha256').update(body).digest('hex');
              if (digest !== expected.sha256 || body.length !== expected.size) {
                throw new Error(`seq ${seq} artifact ${name} failed integrity check`);
              }
              bodies.push([name, body]);
            }
            bodies.push([MANIFEST_NAME, manifestRaw]);
            receipt.seqs.push(seq);
            for (const [name, body] of bodies) {
              receipt.bytes += body.length;
              if (!args.apply) continue;
              const ref = await archiveBytes({
                rootAgentId: session.rootAgentId,
                objectPath: `code/${session.id}/${seq}/${name}`,
                body,
                ...contentTypeFor(name),
                createOnly: true,
              });
              if (ref === null) receipt.existing += 1;
              else receipt.archived += 1;
            }
          }
          process.stdout.write(
            `OK ${session.id} root=${session.rootAgentId} lastActive=${session.lastActiveAt.toISOString()} seqs=${receipt.seqs.join(',') || '-'} archived=${receipt.archived} existing=${receipt.existing} bytes=${receipt.bytes}\n`
          );
        } catch (error) {
          failures += 1;
          process.stdout.write(
            `FAIL ${session.id} ${error instanceof Error ? error.message : String(error)}\n`
          );
        }
      })
    )
  );
  await prisma.$disconnect();
  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
