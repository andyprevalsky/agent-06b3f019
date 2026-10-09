import { isDeepStrictEqual } from 'node:util';
import { runTransactionWithRetry } from './database';
import { retryWithBackoff } from './retry';
import {
  type StoreResult,
  archiveEnabled,
  archiveJson,
  decryptAndValidateArtifact,
  listArchivedObjectsStrict,
  storePlainArtifact,
} from './traceArchive';
import {
  plainArchiveArtifactExists,
  readArchivedArtifactStrict,
  readPlainArchivedArtifact,
} from './traceArchiveStrict';

const TRACE_ARCHIVE_MANIFEST_LOCK_SEED = 8_104_327;
export const TRACE_ARCHIVE_FINALIZING_MARKER = 'manifest.finalization-fence.json';

export type ManifestArtifact = {
  ref: string;
  path?: string | null;
  metadata?: Record<string, unknown> | unknown;
};

type ManifestArtifactRef = {
  ref: string;
  path: string | null;
  content_type: unknown;
  plaintext_bytes: unknown;
  ciphertext_bytes: unknown;
};

export type ManifestReconciliationStatus =
  'current' | 'stale' | 'updated' | 'missing-manifest' | 'not-finalized';

export interface ManifestReconciliationResult {
  rootAgentId: string;
  status: ManifestReconciliationStatus;
  actualArtifactCount: number;
  encryptedManifestArtifactCount: number;
  publicManifestArtifactCount: number;
  missingFromEncrypted: string[];
  missingFromPublic: string[];
  extraInEncrypted: string[];
  extraInPublic: string[];
}

function publicManifestEnabled(): boolean {
  const raw = process.env.TRACE_ARCHIVE_PUBLIC_MANIFEST;
  return (raw !== undefined && raw !== '' ? raw : 'true').toLowerCase() !== 'false';
}

function metadataField(artifact: ManifestArtifact, key: string): unknown {
  const metadata = artifact.metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  return (metadata as Record<string, unknown>)[key];
}

export function artifactPath(artifact: ManifestArtifact): string | null {
  const value = metadataField(artifact, 'path') ?? artifact.path ?? null;
  return typeof value === 'string' ? value : null;
}

function manifestArtifactRef(artifact: ManifestArtifact): ManifestArtifactRef {
  return {
    ref: artifact.ref,
    path: artifactPath(artifact),
    content_type: metadataField(artifact, 'content_type') ?? null,
    plaintext_bytes: metadataField(artifact, 'plaintext_bytes') ?? null,
    ciphertext_bytes: metadataField(artifact, 'ciphertext_bytes') ?? null,
  };
}

export function publicManifest(
  rootAgentId: string,
  artifacts: ManifestArtifact[],
  benchmarkTaskName?: string
): Record<string, unknown> {
  const refs = artifacts.map(manifestArtifactRef);
  return {
    schema_version: 1,
    root_agent_id: rootAgentId,
    benchmark_task_name: benchmarkTaskName ?? null,
    generated_at: new Date().toISOString(),
    artifact_count: refs.length,
    fixture_count: refs.filter((artifact) => artifact.path?.startsWith('db/') === true).length,
    provider_count: refs.filter((artifact) => artifact.path?.startsWith('provider/') === true)
      .length,
    media_count: refs.filter((artifact) => artifact.path?.startsWith('media/') === true).length,
    llm_trace_count: refs.filter((artifact) => artifact.path?.startsWith('llm') === true).length,
    artifacts: refs,
  };
}

export function uniqueArtifacts(artifacts: ManifestArtifact[]): ManifestArtifact[] {
  const seen = new Set<string>();
  const unique: ManifestArtifact[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.ref)) continue;
    seen.add(artifact.ref);
    unique.push(artifact);
  }
  return unique;
}

const CONTROL_ARTIFACT_PATHS = new Set([
  'manifest.json.gz.enc',
  'manifest.public.json',
  TRACE_ARCHIVE_FINALIZING_MARKER,
]);

export function excludeControlArtifacts(artifacts: ManifestArtifact[]): ManifestArtifact[] {
  return artifacts.filter((artifact) => {
    const path = artifactPath(artifact);
    return path === null || !CONTROL_ARTIFACT_PATHS.has(path);
  });
}

export function encryptedManifestIndex(artifacts: ManifestArtifact[]): Record<string, unknown> {
  const refs = artifacts.map(manifestArtifactRef);
  return {
    artifact_refs: refs,
    fixture_refs: refs.filter((artifact) => artifact.path?.startsWith('db/') === true),
    provider_refs: refs.filter((artifact) => artifact.path?.startsWith('provider/') === true),
    media_refs: refs.filter((artifact) => artifact.path?.startsWith('media/') === true),
    llm_trace_refs: refs.filter(
      (artifact) =>
        artifact.path?.startsWith('llm/') === true ||
        artifact.path?.startsWith('llm-updates/') === true
    ),
  };
}

export async function writePublicManifest(
  rootAgentId: string,
  refs: ManifestArtifact[],
  benchmarkTaskName?: string,
  options: { createOnly?: boolean } = {}
): Promise<string | null> {
  if (!publicManifestEnabled()) return null;
  const publicValue = publicManifest(rootAgentId, refs, benchmarkTaskName);
  const publicManifestRef = await storePlainArtifact({
    rootAgentId,
    objectPath: 'manifest.public.json',
    body: Buffer.from(JSON.stringify(publicValue, null, 2)),
    contentType: 'application/json',
    createOnly: options.createOnly,
  });
  if (archiveEnabled() && publicManifestRef === null && !options.createOnly) {
    throw new Error(`Failed to archive required public manifest for ${rootAgentId}`);
  }
  return publicManifestRef;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isManifestArtifact(value: unknown): value is ManifestArtifact {
  return isRecord(value) && typeof value.ref === 'string';
}

function artifactPaths(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const sensitive = isRecord(value.sensitive) ? value.sensitive : null;
  const candidates =
    (sensitive !== null && Array.isArray(sensitive.artifact_refs)
      ? sensitive.artifact_refs
      : null) ?? (Array.isArray(value.artifacts) ? value.artifacts : []);
  return [
    ...new Set(
      candidates
        .filter(isManifestArtifact)
        .map(artifactPath)
        .filter((path): path is string => path !== null)
    ),
  ].sort();
}

function pathDifference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((path) => !rightSet.has(path));
}

function parseJsonRecord(body: Buffer, label: string): Record<string, unknown> {
  const value = JSON.parse(body.toString('utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

type LoadedManifestSnapshot = {
  result: ManifestReconciliationResult;
  manifest: Record<string, unknown> | null;
  refs: ManifestArtifact[];
};

async function loadManifestSnapshot(rootAgentId: string): Promise<LoadedManifestSnapshot> {
  const encrypted = await readArchivedArtifactStrict({
    rootAgentId,
    objectPath: 'manifest.json.gz.enc',
  });
  if (encrypted === null) {
    return {
      result: {
        rootAgentId,
        status: 'missing-manifest',
        actualArtifactCount: 0,
        encryptedManifestArtifactCount: 0,
        publicManifestArtifactCount: 0,
        missingFromEncrypted: [],
        missingFromPublic: [],
        extraInEncrypted: [],
        extraInPublic: [],
      },
      manifest: null,
      refs: [],
    };
  }

  const manifest = parseJsonRecord(
    decryptAndValidateArtifact(encrypted),
    `Encrypted trace archive manifest for ${rootAgentId}`
  );
  if (manifest.finalized !== true) {
    return {
      result: {
        rootAgentId,
        status: 'not-finalized',
        actualArtifactCount: 0,
        encryptedManifestArtifactCount: artifactPaths(manifest).length,
        publicManifestArtifactCount: 0,
        missingFromEncrypted: [],
        missingFromPublic: [],
        extraInEncrypted: [],
        extraInPublic: [],
      },
      manifest,
      refs: [],
    };
  }

  const includePublicManifest = publicManifestEnabled();
  const [listed, publicBody] = await Promise.all([
    listArchivedObjectsStrict(rootAgentId),
    includePublicManifest
      ? readPlainArchivedArtifact({
          rootAgentId,
          objectPath: 'manifest.public.json',
        })
      : Promise.resolve(null),
  ]);
  const refs = uniqueArtifacts(excludeControlArtifacts(listed));
  const actual = refs
    .map(artifactPath)
    .filter((path): path is string => path !== null)
    .sort();
  const encryptedPaths = artifactPaths(manifest);
  const publicValue =
    publicBody === null
      ? null
      : parseJsonRecord(publicBody, `Public trace archive manifest for ${rootAgentId}`);
  const publicPaths = artifactPaths(publicValue);
  const missingFromEncrypted = pathDifference(actual, encryptedPaths);
  const missingFromPublic = includePublicManifest ? pathDifference(actual, publicPaths) : [];
  const extraInEncrypted = pathDifference(encryptedPaths, actual);
  const extraInPublic = includePublicManifest ? pathDifference(publicPaths, actual) : [];
  const stale =
    (includePublicManifest && publicValue === null) ||
    missingFromEncrypted.length > 0 ||
    missingFromPublic.length > 0 ||
    extraInEncrypted.length > 0 ||
    extraInPublic.length > 0;

  return {
    result: {
      rootAgentId,
      status: stale ? 'stale' : 'current',
      actualArtifactCount: actual.length,
      encryptedManifestArtifactCount: encryptedPaths.length,
      publicManifestArtifactCount: publicPaths.length,
      missingFromEncrypted,
      missingFromPublic,
      extraInEncrypted,
      extraInPublic,
    },
    manifest,
    refs,
  };
}

export async function inspectFinalizedManifest(
  rootAgentId: string
): Promise<ManifestReconciliationResult> {
  return (await loadManifestSnapshot(rootAgentId)).result;
}

type ManifestLockOwnership = {
  assertOwned: () => Promise<void>;
  reconcile: () => Promise<ManifestReconciliationResult>;
};

// Lock holders run nested queries on the shared pool (planner memory, trajectory
// search). A same-root waiter therefore releases its connection between bounded
// waits; otherwise waiters can fill the pool and starve the holder they wait on.
const MANIFEST_LOCK_ATTEMPT_MS = 2_000;
const MANIFEST_LOCK_WAIT_MS = 120_000;
const MANIFEST_LOCK_RETRY_DELAY_MS = 100;
const POSTGRES_LOCK_NOT_AVAILABLE = '55P03';

class ArchiveManifestLockBusyError extends Error {
  constructor(rootAgentId: string) {
    super(`Trace archive manifest lock is busy for ${rootAgentId}`);
    this.name = 'ArchiveManifestLockBusyError';
  }
}

function isLockNotAvailable(error: unknown): boolean {
  const meta = (error as { meta?: { code?: unknown } } | null)?.meta;
  return meta?.code === POSTGRES_LOCK_NOT_AVAILABLE;
}

export async function withArchiveManifestLock<T>(
  rootAgentId: string,
  operation: (ownership: ManifestLockOwnership) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  return retryWithBackoff(() => attemptArchiveManifestLock(rootAgentId, operation), {
    maxRetries: Math.ceil(MANIFEST_LOCK_WAIT_MS / MANIFEST_LOCK_ATTEMPT_MS) + 1,
    getBackoffDelayMs: () => MANIFEST_LOCK_RETRY_DELAY_MS,
    isRetryable: (error) => error instanceof ArchiveManifestLockBusyError && Date.now() < deadline,
    component: 'ArchiveManifestLock',
  });
}

async function reportBusyLock<T>(rootAgentId: string, acquisition: Promise<T>): Promise<T> {
  try {
    return await acquisition;
  } catch (error) {
    if (isLockNotAvailable(error)) throw new ArchiveManifestLockBusyError(rootAgentId);
    throw error;
  }
}

async function attemptArchiveManifestLock<T>(
  rootAgentId: string,
  operation: (ownership: ManifestLockOwnership) => Promise<T>
): Promise<T> {
  let enteredOperation: Promise<T> | undefined;
  try {
    return await runTransactionWithRetry(
      async (tx) => {
        await reportBusyLock(
          rootAgentId,
          tx.$queryRaw`
          WITH settings AS MATERIALIZED (
            SELECT set_config('idle_in_transaction_session_timeout', '120s', true),
              set_config('lock_timeout', ${`${MANIFEST_LOCK_ATTEMPT_MS}ms`}, true)
          ), acquired AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(
              hashtextextended(${`${rootAgentId}:trace-archive-manifest`}, ${TRACE_ARCHIVE_MANIFEST_LOCK_SEED})
            )
            FROM settings
          )
          SELECT 1 AS locked FROM acquired
        `
        );
        const assertOwned = async () => {
          // A timed-out/terminated interactive transaction no longer owns the lock.
          await tx.$queryRaw`SELECT 1 AS owned`;
        };
        enteredOperation = (async () => {
          const result = await operation({
            assertOwned,
            reconcile: () => reconcileFinalizedManifestLocked(rootAgentId, assertOwned),
          });
          await assertOwned();
          return result;
        })();
        void enteredOperation.catch(() => {});
        return enteredOperation;
      },
      { maxWait: 10_000, timeout: 120_000 }
    );
  } finally {
    // Prisma can reject on expiry before the callback's bounded storage I/O ends.
    // Join that work; ownership checks prevent another rewrite or a false ACK.
    await enteredOperation?.catch(() => {});
  }
}

export async function writeFinalizationMarker(rootAgentId: string): Promise<void> {
  const marker = await storePlainArtifact({
    rootAgentId,
    objectPath: TRACE_ARCHIVE_FINALIZING_MARKER,
    body: Buffer.from(
      JSON.stringify({
        schema_version: 1,
        root_agent_id: rootAgentId,
        finalization_started_at: new Date().toISOString(),
      })
    ),
    contentType: 'application/json',
  });
  if (archiveEnabled() && marker === null) {
    throw new Error(`Failed to archive finalization marker for ${rootAgentId}`);
  }
}

async function rewriteManifestFromSnapshot(
  snapshot: LoadedManifestSnapshot,
  assertOwned: () => Promise<void>
): Promise<{ manifest: StoreResult | null; publicManifestRef: string | null }> {
  const { manifest, refs, result } = snapshot;
  if (manifest === null || result.status === 'not-finalized') {
    return { manifest: null, publicManifestRef: null };
  }
  const benchmarkTaskName =
    typeof manifest.benchmark_task_name === 'string' ? manifest.benchmark_task_name : undefined;
  const sensitive = isRecord(manifest.sensitive) ? manifest.sensitive : {};
  const manifestValue = {
    ...manifest,
    ...publicManifest(result.rootAgentId, refs, benchmarkTaskName),
    finalized: true,
    sensitive: {
      ...sensitive,
      ...encryptedManifestIndex(refs),
    },
  };
  await assertOwned();
  const encryptedManifest = await archiveJson({
    rootAgentId: result.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: manifestValue,
  });
  if (archiveEnabled() && encryptedManifest === null) {
    throw new Error(`Failed to reconcile encrypted manifest for ${result.rootAgentId}`);
  }
  await assertOwned();
  const publicManifestRef = await writePublicManifest(result.rootAgentId, refs, benchmarkTaskName);
  await assertOwned();
  return { manifest: encryptedManifest, publicManifestRef };
}

function unchangedTerminalMetadata(
  previous: Record<string, unknown> | null,
  current: Record<string, unknown> | null
): boolean {
  const terminal = (manifest: Record<string, unknown> | null) => {
    if (manifest === null) return null;
    const copy = { ...manifest };
    for (const key of Object.keys(publicManifest('', []))) {
      if (key !== 'root_agent_id' && key !== 'benchmark_task_name') delete copy[key];
    }
    copy.benchmark_task_name = copy.benchmark_task_name ?? null;
    if (isRecord(copy.sensitive)) {
      const sensitive = { ...copy.sensitive };
      for (const key of Object.keys(encryptedManifestIndex([]))) delete sensitive[key];
      copy.sensitive = sensitive;
    }
    return copy;
  };
  return isDeepStrictEqual(terminal(previous), terminal(current));
}

function onlyConcurrentAdditions(
  previous: LoadedManifestSnapshot,
  current: LoadedManifestSnapshot
): boolean {
  if (
    current.result.status !== 'stale' ||
    current.result.extraInEncrypted.length > 0 ||
    current.result.extraInPublic.length > 0 ||
    !unchangedTerminalMetadata(previous.manifest, current.manifest)
  )
    return false;
  const before = previous.refs.map(artifactPath).filter((path): path is string => path !== null);
  const after = current.refs.map(artifactPath).filter((path): path is string => path !== null);
  if (pathDifference(before, after).length > 0) return false;
  const added = new Set(pathDifference(after, before));
  return (
    added.size > 0 &&
    [...current.result.missingFromEncrypted, ...current.result.missingFromPublic].every((path) =>
      added.has(path)
    )
  );
}

async function reconcileFinalizedManifestLocked(
  rootAgentId: string,
  assertOwned: () => Promise<void>
): Promise<ManifestReconciliationResult> {
  await assertOwned();
  let snapshot = await loadManifestSnapshot(rootAgentId);
  if (snapshot.result.status !== 'stale') return snapshot.result;
  for (;;) {
    await rewriteManifestFromSnapshot(snapshot, assertOwned);
    const verified = await loadManifestSnapshot(rootAgentId);
    await assertOwned();
    if (verified.result.status === 'current') return { ...verified.result, status: 'updated' };
    if (!onlyConcurrentAdditions(snapshot, verified)) {
      throw new Error(
        `Trace archive manifest reconciliation did not converge for ${rootAgentId}: ${verified.result.status}`
      );
    }
    // Retry only a strictly observed monotonic addition. The existing live SQL
    // transaction bounds publication; errors/removals/control overwrites fail.
    snapshot = verified;
  }
}

export async function reconcileFinalizedManifest(
  rootAgentId: string,
  options: { markerExists?: boolean } = {}
): Promise<ManifestReconciliationResult> {
  if (!options.markerExists) await writeFinalizationMarker(rootAgentId);
  return withArchiveManifestLock(rootAgentId, (ownership) => ownership.reconcile());
}

export async function finalizationFenceExists(rootAgentId: string): Promise<boolean> {
  return plainArchiveArtifactExists({
    rootAgentId,
    objectPath: TRACE_ARCHIVE_FINALIZING_MARKER,
  });
}
