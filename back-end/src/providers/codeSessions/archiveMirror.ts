/**
 * Lossless trace archive of code-session checkpoints. Every checkpoint is
 * copied into its root agent's encrypted R2 bundle, and Supabase drops a
 * checkpoint (pruning, retirement) only once that copy is confirmed.
 *
 *   Supabase  user/<userId>/code-sessions/<id>/<seq>/<artifact>
 *      └──► R2 trace-archive/<root>/code/<id>/<seq>/<artifact>   encrypted, create-only,
 *                                                                manifest.json last
 *
 *   checkpoint ─► Supabase write ─► commit ─► archive job (bounded per process):
 *                   mirror this seq (its bytes, when a slot is free; else reloaded
 *                   from Supabase) ─► prune seq − RESTORE_LOOKBACK
 *   prune / retire ─► ensureCheckpointArchived(seq):
 *                   confirmed? every artifact's and the manifest's archived
 *                   plaintext sha256 + size match the Supabase manifest
 *                   else mirror from Supabase (hash-checked), confirm again
 *                   unconfirmed / any error ─► throw: the checkpoint stays, retried later
 *
 * Root: the session's rootAgentId resolved to its tree root (archiveRootResolver),
 * so a session keyed by a sub-agent still lands in its root bundle.
 *
 * 10k agents: per checkpoint one short parent walk and one object write per
 * artifact; confirmation reads only the small .meta.json sidecars. At most
 * ARCHIVE_JOB_CONCURRENCY jobs run per process and only running jobs hold
 * checkpoint bytes; queued jobs hold ids and reload from Supabase.
 */
import { createHash } from 'crypto';
import { resolveArchiveRoot } from '../archiveRootResolver';
import { createLogger } from '../logger';
import { archiveBytes, archiveEnabled, safeArchivePath } from '../traceArchive';
import { metadataFromUnknown } from '../traceArchiveEnvelope';
import { readPlainArchivedArtifact } from '../traceArchiveStrict';
import { checkpointKey, getCheckpointObject } from './artifactStore';
import { MANIFEST_NAME as MANIFEST } from './checkpoint';

const log = createLogger('CodeSessionArchive');

export class CheckpointArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointArchiveError';
  }
}

/** Identity of one session's archive: Supabase keys plus the resolved root bundle. */
export interface CheckpointArchiveTarget {
  userId: string;
  codeSessionId: string;
  /** The tree root (resolveArchiveRootAgentId). */
  rootAgentId: string;
}

/** Bundle-relative path of one checkpoint object: code/<id>/<seq>/<artifact>. */
export function codeCheckpointArchivePath(
  codeSessionId: string,
  seq: number,
  name: string
): string {
  return `code/${codeSessionId}/${seq}/${name}`;
}

export function archiveContentType(name: string): {
  contentType: string;
  compress: boolean | undefined;
} {
  if (name.endsWith('.json')) return { contentType: 'application/json', compress: true };
  if (name.endsWith('.jsonl')) return { contentType: 'application/x-ndjson', compress: true };
  if (name.endsWith('.gz')) return { contentType: 'application/gzip', compress: false };
  return { contentType: 'application/octet-stream', compress: undefined };
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The tree root of `agentId`: the one root resolver every archive writer uses
 * (busId, else a parentAgentId walk; an unknown agent is its own root).
 */
export async function resolveArchiveRootAgentId(agentId: string): Promise<string> {
  return resolveArchiveRoot(agentId);
}

export async function archiveTargetFor(session: {
  id: string;
  userId: string;
  rootAgentId: string;
}): Promise<CheckpointArchiveTarget> {
  return {
    userId: session.userId,
    codeSessionId: session.id,
    rootAgentId: await resolveArchiveRootAgentId(session.rootAgentId),
  };
}

/** Artifacts a manifest names (none for an unparseable manifest, which is still archived). */
function manifestArtifacts(
  manifestBytes: Buffer
): Array<[string, { sha256: string; size: number }]> {
  try {
    const parsed = JSON.parse(manifestBytes.toString('utf8')) as {
      artifacts?: Record<string, { sha256: string; size: number }>;
    };
    return Object.entries(parsed.artifacts ?? {});
  } catch {
    return [];
  }
}

export interface CheckpointArchiveReceipt {
  archived: number;
  existing: number;
  bytes: number;
}

/**
 * Copy one checkpoint into the root bundle, manifest last. `artifacts` are its
 * bytes when the caller holds them; missing ones are read from Supabase and
 * hash-checked against the manifest (a missing or corrupt artifact throws).
 * Create-only: an object already archived is never rewritten.
 */
export async function mirrorCheckpointToArchive(params: {
  target: CheckpointArchiveTarget;
  seq: number;
  manifestBytes: Buffer;
  artifacts?: Map<string, Buffer>;
}): Promise<CheckpointArchiveReceipt> {
  const { target, seq, manifestBytes } = params;
  if (!archiveEnabled()) {
    throw new CheckpointArchiveError('Trace archive is disabled; checkpoints stay in storage');
  }
  const receipt: CheckpointArchiveReceipt = { archived: 0, existing: 0, bytes: 0 };
  const store = async (name: string, body: Buffer): Promise<void> => {
    const ref = await archiveBytes({
      rootAgentId: target.rootAgentId,
      objectPath: codeCheckpointArchivePath(target.codeSessionId, seq, name),
      body,
      ...archiveContentType(name),
      createOnly: true,
    });
    receipt.bytes += body.length;
    if (ref === null) receipt.existing += 1;
    else receipt.archived += 1;
  };
  for (const [name, expected] of manifestArtifacts(manifestBytes)) {
    let body = params.artifacts?.get(name) ?? null;
    if (body === null) {
      body = await getCheckpointObject(
        checkpointKey(target.userId, target.codeSessionId, seq, name)
      );
      if (body === null) {
        throw new CheckpointArchiveError(`Checkpoint ${seq} artifact ${name} is missing`);
      }
    }
    if (body.length !== expected.size || sha256(body) !== expected.sha256) {
      throw new CheckpointArchiveError(`Checkpoint ${seq} artifact ${name} failed sha256 check`);
    }
    await store(name, body);
  }
  await store(MANIFEST, manifestBytes);
  return receipt;
}

/**
 * Whether the root bundle holds this exact checkpoint: every artifact and the
 * manifest has an archived sidecar whose plaintext sha256 and size match.
 * Storage errors throw (an outage is never read as "absent").
 */
export async function checkpointArchiveConfirmed(params: {
  target: CheckpointArchiveTarget;
  seq: number;
  manifestBytes: Buffer;
}): Promise<boolean> {
  const { target, seq, manifestBytes } = params;
  if (!archiveEnabled()) return false;
  const expected: Array<[string, { sha256: string; size: number }]> = [
    ...manifestArtifacts(manifestBytes),
    [MANIFEST, { sha256: sha256(manifestBytes), size: manifestBytes.length }],
  ];
  for (const [name, want] of expected) {
    const objectPath = codeCheckpointArchivePath(target.codeSessionId, seq, name);
    const raw = await readPlainArchivedArtifact({
      rootAgentId: target.rootAgentId,
      objectPath: `${objectPath}.meta.json`,
    });
    if (raw === null) return false;
    let meta;
    try {
      meta = metadataFromUnknown(JSON.parse(raw.toString('utf8')));
    } catch {
      return false;
    }
    if (
      meta.path !== safeArchivePath(objectPath) ||
      meta.plaintext_sha256 !== want.sha256 ||
      meta.plaintext_bytes !== want.size
    ) {
      return false;
    }
  }
  return true;
}

export type EnsureArchivedResult = 'absent' | 'confirmed' | 'mirrored';

/**
 * Make sure checkpoint `seq` is in the root bundle before Supabase drops it.
 * 'absent': Supabase has no manifest for it (nothing to protect). Throws when
 * the copy cannot be confirmed; the caller keeps the checkpoint.
 */
export async function ensureCheckpointArchived(
  session: { id: string; userId: string; rootAgentId: string },
  seq: number,
  target?: CheckpointArchiveTarget
): Promise<EnsureArchivedResult> {
  const manifestBytes = await getCheckpointObject(
    checkpointKey(session.userId, session.id, seq, MANIFEST)
  );
  if (manifestBytes === null) return 'absent';
  const resolved = target ?? (await archiveTargetFor(session));
  if (await checkpointArchiveConfirmed({ target: resolved, seq, manifestBytes }))
    return 'confirmed';
  const receipt = await mirrorCheckpointToArchive({ target: resolved, seq, manifestBytes });
  if (!(await checkpointArchiveConfirmed({ target: resolved, seq, manifestBytes }))) {
    throw new CheckpointArchiveError(
      `Checkpoint ${seq} of code session ${session.id} is not confirmed in the trace archive`
    );
  }
  log.info('Code session checkpoint archived from storage', {
    codeSessionId: session.id,
    rootAgentId: resolved.rootAgentId,
    seq: String(seq),
    archived: String(receipt.archived),
    existing: String(receipt.existing),
  });
  return 'mirrored';
}

// ── Background archive jobs ────────────────────────────────────────────────

const ARCHIVE_JOB_CONCURRENCY = 2;
let runningJobs = 0;
const queuedJobs: Array<() => Promise<void>> = [];
const pendingJobs = new Set<Promise<void>>();

function startJob(job: () => Promise<void>): void {
  runningJobs += 1;
  const promise = job()
    .catch((error: unknown) => {
      log.warn('Code session archive job failed; retried at prune or retire', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      runningJobs -= 1;
      pendingJobs.delete(promise);
      const next = queuedJobs.shift();
      if (next !== undefined) startJob(next);
    });
  pendingJobs.add(promise);
}

/**
 * Run an archive job in the background. `withBytes` runs only when a slot is
 * free right now; otherwise `fromStorage` is queued, so a burst of checkpoints
 * never holds their bytes in memory. Build the two closures in separate scopes
 * (a shared scope would keep the bytes alive through `fromStorage`).
 */
export function scheduleCheckpointArchiveJob(
  withBytes: () => Promise<void>,
  fromStorage: () => Promise<void>
): void {
  if (runningJobs < ARCHIVE_JOB_CONCURRENCY) startJob(withBytes);
  else queuedJobs.push(fromStorage);
}

/** Wait until every scheduled archive job has finished (tests, graceful drain). */
export async function waitForCodeSessionArchiveJobs(): Promise<void> {
  while (pendingJobs.size > 0 || queuedJobs.length > 0) {
    await Promise.allSettled([...pendingJobs]);
  }
}
