import { createLogger } from './logger';
import { collectFixture, collectFixtureSnapshot } from './traceArchiveFixture';
import {
  type EncryptedArtifactMetadata,
  archiveJson,
  archiveEnabled,
  listArchivedObjects,
  safeArchivePath,
  storeEncryptedArtifact,
  storePlainArtifact,
  validateEncryptedArtifactEnvelope,
} from './traceArchive';

const log = createLogger('Archive');
const rawPublicManifest = process.env.TRACE_ARCHIVE_PUBLIC_MANIFEST;
const TRACE_ARCHIVE_PUBLIC_MANIFEST =
  (rawPublicManifest !== undefined && rawPublicManifest !== ''
    ? rawPublicManifest
    : 'true'
  ).toLowerCase() !== 'false';
const rawBaseImageHash = process.env.TRACE_ARCHIVE_BASE_IMAGE_HASH;
const TRACE_ARCHIVE_BASE_IMAGE_HASH =
  rawBaseImageHash !== undefined && rawBaseImageHash !== '' ? rawBaseImageHash : null;
const FINALIZABLE_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
  'CANCELLED',
  'CANCELED',
  'PASSED',
  'ERROR',
]);

export interface StoreEncryptedArtifactRequest {
  rootAgentId: string;
  path: string;
  ciphertextB64: string;
  metadata: EncryptedArtifactMetadata;
}

export interface AgentStartRequest {
  agentId: string;
}

export interface AgentFinalizeRequest {
  rootAgentId: string;
  benchmarkTaskName?: string;
  benchmarkPassed?: boolean;
  benchmarkStatus?: string;
  failureReason?: string | null;
  /** World-model execution mode of the run (real | shadow | simulate). Defaults to real. */
  worldModelMode?: string;
  force?: boolean;
}

export interface ArchiveArtifactRef {
  ref: string;
  metadata?: EncryptedArtifactMetadata;
}

type ManifestArtifact = {
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
type FinalizeAgentResult = {
  manifest: ArchiveArtifactRef | null;
  publicManifestRef: string | null;
};

const finalizeInFlight = new Map<string, Promise<FinalizeAgentResult>>();

function artifactPath(artifact: ManifestArtifact): string | null {
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

function normalizedWorldModelMode(mode: string | undefined): string {
  const value = (mode ?? 'real').trim().toLowerCase();
  return value === '' ? 'real' : value;
}

function publicManifest(
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

function metadataField(artifact: ManifestArtifact, key: string): unknown {
  const metadata = artifact.metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function uniqueArtifacts(artifacts: ManifestArtifact[]): ManifestArtifact[] {
  const seen = new Set<string>();
  const unique: ManifestArtifact[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.ref)) continue;
    seen.add(artifact.ref);
    unique.push(artifact);
  }
  return unique;
}

// The manifest itself is now written at agent start, so listArchivedObjects()
// returns the manifest control files on every subsequent write. Exclude them so
// a bundle's manifest never indexes itself (which would inflate artifact counts
// and self-reference the manifest).
const CONTROL_ARTIFACT_PATHS = new Set(['manifest.json.gz.enc', 'manifest.public.json']);
function excludeControlArtifacts(artifacts: ManifestArtifact[]): ManifestArtifact[] {
  return artifacts.filter((artifact) => {
    const path = artifactPath(artifact);
    return path === null || !CONTROL_ARTIFACT_PATHS.has(path);
  });
}

function encryptedRunMetadata(fixture: {
  rows: Record<string, unknown[]>;
  user_id: string;
  agent_ids: string[];
  base_image: string;
  captured_at: string;
}): Record<string, unknown> {
  const root = fixture.rows.Agent.find(
    (row) => (row as { id?: unknown }).id === fixture.agent_ids[0]
  ) as Record<string, unknown> | undefined;
  return {
    root_goal: root?.goal ?? null,
    root_status: root?.status ?? null,
    root_created_at: root?.createdAt ?? null,
    root_updated_at: root?.updatedAt ?? null,
    user_id: fixture.user_id,
    agent_ids: fixture.agent_ids,
    base_image: fixture.base_image,
    base_image_hash: TRACE_ARCHIVE_BASE_IMAGE_HASH,
    end_fixture_captured_at: fixture.captured_at,
  };
}

function encryptedManifestIndex(artifacts: ManifestArtifact[]): Record<string, unknown> {
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

function benchmarkResultFromInput(
  input: Pick<AgentFinalizeRequest, 'benchmarkPassed' | 'benchmarkStatus' | 'failureReason'>
): Record<string, unknown> | null {
  if (input.benchmarkPassed === undefined && input.benchmarkStatus === undefined) return null;
  return {
    passed: input.benchmarkPassed ?? null,
    status: input.benchmarkStatus ?? null,
    failure_reason: input.failureReason ?? null,
  };
}

/**
 * Assembles the `manifest.json.gz.enc` value shared by the two lifecycle writes:
 * the initial manifest written at agent start and the terminal update written at
 * finalize. The manifest exists from creation so a run that crashes or is killed
 * mid-flight still has a classifiable, ingestible bundle (its `world_model_mode`
 * gates world-model eligibility; a missing manifest reads as "unknown" and is
 * dropped). `finalized` distinguishes the living start manifest from the terminal
 * one; downstream ingest derives transitions by listing the bundle's actual
 * artifacts, so a start manifest with a sparse artifact index is still usable.
 */
function buildManifestValue(params: {
  rootAgentId: string;
  refs: ManifestArtifact[];
  worldModelMode: string | undefined;
  benchmarkTaskName?: string;
  benchmarkResult: Record<string, unknown> | null;
  run: Record<string, unknown>;
  correlations: { root_agent_id: string; user_id: string; agent_ids: string[] };
  finalized: boolean;
  force: boolean;
}): Record<string, unknown> {
  return {
    ...publicManifest(params.rootAgentId, params.refs, params.benchmarkTaskName),
    world_model_mode: normalizedWorldModelMode(params.worldModelMode),
    finalized: params.finalized,
    benchmark_result: params.benchmarkResult,
    run: params.run,
    correlations: params.correlations,
    sensitive: {
      ...encryptedManifestIndex(params.refs),
      force: params.force,
    },
  };
}

function rootStatusFromFixture(fixture: { rows: Record<string, unknown[]>; agent_ids: string[] }) {
  const rootAgentId = fixture.agent_ids[0];
  const root = fixture.rows.Agent.find((row) => (row as { id?: unknown }).id === rootAgentId) as
    Record<string, unknown> | undefined;
  return typeof root?.status === 'string' ? root.status : null;
}

export function assertArchiveFinalizable(
  input: AgentFinalizeRequest,
  fixture: { rows: Record<string, unknown[]>; agent_ids: string[] }
): void {
  if (input.force === true) return;
  const status = input.benchmarkStatus ?? rootStatusFromFixture(fixture);
  if (typeof status === 'string' && FINALIZABLE_STATUSES.has(status)) return;
  throw new Error(
    `Trace archive finalization requires a terminal status for ${input.rootAgentId}; got ${
      status ?? 'unknown'
    }`
  );
}

export async function storeWorkerArtifact(
  input: StoreEncryptedArtifactRequest
): Promise<{ ref: string }> {
  const objectPath = safeArchivePath(input.path);
  const ciphertext = Buffer.from(input.ciphertextB64, 'base64');
  const metadata = validateEncryptedArtifactEnvelope({
    objectPath,
    ciphertext,
    metadata: input.metadata,
  });
  const ref = await storeEncryptedArtifact({
    rootAgentId: input.rootAgentId,
    objectPath,
    ciphertext,
    metadata,
  });
  if (ref === null) {
    throw new Error('Trace archive is disabled or unavailable');
  }
  return { ref };
}

export async function captureAgentStart(
  input: AgentStartRequest
): Promise<{ fixture: ArchiveArtifactRef | null }> {
  const fixture = await collectAgentStartFixture(input);
  return archiveAgentStartFixture(input.agentId, fixture);
}

export async function collectAgentStartFixture(
  input: AgentStartRequest
): Promise<Awaited<ReturnType<typeof collectFixture>>> {
  return collectFixture(input.agentId, 'start');
}

export async function archiveAgentStartFixture(
  agentId: string,
  fixture: Awaited<ReturnType<typeof collectFixture>>
): Promise<{ fixture: ArchiveArtifactRef | null }> {
  const result = await archiveJson({
    rootAgentId: agentId,
    objectPath: 'db/start.fixture.json.gz.enc',
    value: fixture,
  });
  // Write the bundle manifest at creation so every started run is immediately a
  // classifiable, world-model-ingestible bundle — a run that crashes or is
  // SIGKILLed before it can finalize still has a manifest, so its partial
  // trajectory is usable rather than silently dropped as "unknown" mode. Best
  // effort: a manifest failure must never break launch-critical start capture.
  try {
    await writeStartManifest(agentId, fixture);
  } catch (error) {
    log.warn('Trace archive start manifest unavailable', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { fixture: result };
}

/** Best-effort public manifest mirror; shared by the start and finalize writes. */
async function writePublicManifest(
  rootAgentId: string,
  refs: ManifestArtifact[],
  benchmarkTaskName?: string
): Promise<string | null> {
  if (!TRACE_ARCHIVE_PUBLIC_MANIFEST) return null;
  const publicValue = publicManifest(rootAgentId, refs, benchmarkTaskName);
  const publicManifestRef = await storePlainArtifact({
    rootAgentId,
    objectPath: 'manifest.public.json',
    body: Buffer.from(JSON.stringify(publicValue, null, 2)),
    contentType: 'application/json',
  });
  if (archiveEnabled() && publicManifestRef === null) {
    throw new Error(`Failed to archive required public manifest for ${rootAgentId}`);
  }
  return publicManifestRef;
}

/** Non-eligible placeholder mode for a bundle whose true mode isn't known yet. */
const PENDING_WORLD_MODEL_MODE = 'pending';

/**
 * The creation-time world-model mode for a root agent. Product agents use the
 * persisted per-agent mode. Benchmark runs can be shadow/simulate and their true
 * mode is only known at finalize; marking them `pending` (a non-real mode) keeps
 * a crashed simulated run OUT of the real-world corpus until finalize stamps it.
 */
function startWorldModelMode(
  agentId: string,
  fixture: Awaited<ReturnType<typeof collectFixture>>
): string {
  const root = fixture.rows.Agent?.find((row) => (row as { id?: unknown }).id === agentId) as
    { isBenchmark?: unknown; worldModelMode?: unknown } | undefined;
  if (root?.isBenchmark === true) return PENDING_WORLD_MODEL_MODE;
  return root?.worldModelMode === 'simulate' || root?.worldModelMode === 'shadow'
    ? root.worldModelMode
    : 'real';
}

/**
 * Writes the initial `manifest.json.gz.enc` at agent start. Only the root agent
 * owns its bundle manifest (sub-agent artifacts live under the root bundle). See
 * `startWorldModelMode` for how the creation-time mode avoids misclassifying a
 * crashed benchmark/simulate run as real while keeping crashed prod runs usable.
 */
async function writeStartManifest(
  agentId: string,
  fixture: Awaited<ReturnType<typeof collectFixture>>
): Promise<void> {
  if (fixture.agent_ids[0] !== agentId) return;
  const refs = uniqueArtifacts(excludeControlArtifacts(await listArchivedObjects(agentId)));
  const manifestValue = buildManifestValue({
    rootAgentId: agentId,
    refs,
    worldModelMode: startWorldModelMode(agentId, fixture),
    benchmarkResult: null,
    run: encryptedRunMetadata(fixture),
    correlations: {
      root_agent_id: agentId,
      user_id: fixture.user_id,
      agent_ids: fixture.agent_ids,
    },
    finalized: false,
    force: false,
  });
  const manifest = await archiveJson({
    rootAgentId: agentId,
    objectPath: 'manifest.json.gz.enc',
    value: manifestValue,
  });
  await writePublicManifest(agentId, refs);
  if (manifest !== null) {
    log.info('Trace archive manifest initialized at start', {
      root_agent_id: agentId,
      artifact_count: refs.length,
    });
  }
}

type PreparedArchiveTask<TFixture> = {
  collect: (markSnapshotReady: () => void) => Promise<TFixture>;
  archive: (fixture: TFixture) => Promise<void>;
  onError: (error: unknown) => void;
};

type FixtureOutcome<TFixture> = { ok: true; fixture: TFixture } | { ok: false; error: unknown };

/**
 * Splits snapshot acquisition (launch-critical) from fixture completion and
 * archival (post-launch). The outcome promise always resolves, so a failure
 * after readiness cannot become an unhandled rejection while launch proceeds.
 */
export async function prepareAgentStartArchiveTask<TFixture>(
  task: PreparedArchiveTask<TFixture>
): Promise<(() => Promise<void>) | null> {
  let snapshotReady = false;
  let resolveSnapshotReady: (() => void) | undefined;
  let rejectSnapshotReady: ((error: unknown) => void) | undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    resolveSnapshotReady = resolve;
    rejectSnapshotReady = reject;
  });
  const markSnapshotReady = () => {
    if (snapshotReady) return;
    snapshotReady = true;
    resolveSnapshotReady?.();
  };

  const fixtureOutcome: Promise<FixtureOutcome<TFixture>> = Promise.resolve()
    .then(() => task.collect(markSnapshotReady))
    .then<FixtureOutcome<TFixture>, FixtureOutcome<TFixture>>(
      (fixture) => {
        if (!snapshotReady) {
          const error = new Error('Start fixture collection completed before snapshot readiness');
          rejectSnapshotReady?.(error);
          return { ok: false, error };
        }
        return { ok: true, fixture };
      },
      (error: unknown) => {
        if (!snapshotReady) rejectSnapshotReady?.(error);
        return { ok: false, error };
      }
    );

  try {
    await readiness;
  } catch (error) {
    task.onError(error);
    return null;
  }

  return async () => {
    const outcome = await fixtureOutcome;
    if (!outcome.ok) {
      task.onError(outcome.error);
      return;
    }
    try {
      await task.archive(outcome.fixture);
    } catch (error) {
      task.onError(error);
    }
  };
}

export async function prepareAgentStartArchive(
  agentId: string
): Promise<(() => Promise<void>) | null> {
  if (!archiveEnabled()) return null;

  const reportUnavailable = (error: unknown) => {
    log.warn('Trace archive start fixture unavailable', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  };
  return prepareAgentStartArchiveTask({
    collect: (markSnapshotReady) => collectFixtureSnapshot(agentId, 'start', markSnapshotReady),
    archive: async (fixture) => {
      const result = await archiveAgentStartFixture(agentId, fixture);
      if (result.fixture !== null) {
        log.info('Trace archive start fixture captured', {
          agent_id: agentId,
          ref: result.fixture.ref,
        });
      }
    },
    onError: reportUnavailable,
  });
}

async function waitForActiveFinalize(rootAgentId: string): Promise<void> {
  while (true) {
    const active = finalizeInFlight.get(rootAgentId);
    if (active === undefined) return;
    try {
      await active;
    } catch {
      // The caller that owns the active promise reports the failure. Waiters only need the lock.
    }
  }
}

export async function finalizeAgent(input: AgentFinalizeRequest): Promise<FinalizeAgentResult> {
  await waitForActiveFinalize(input.rootAgentId);
  const finalize = finalizeAgentOnce(input);
  finalizeInFlight.set(input.rootAgentId, finalize);
  try {
    return await finalize;
  } finally {
    if (finalizeInFlight.get(input.rootAgentId) === finalize) {
      finalizeInFlight.delete(input.rootAgentId);
    }
  }
}

async function finalizeAgentOnce(input: AgentFinalizeRequest): Promise<FinalizeAgentResult> {
  const endFixture = await collectFixture(input.rootAgentId, 'end');
  assertArchiveFinalizable(input, endFixture);
  const fixtureRef = await archiveJson({
    rootAgentId: input.rootAgentId,
    objectPath: 'db/end.fixture.json.gz.enc',
    value: endFixture,
  });
  if (archiveEnabled() && fixtureRef === null) {
    throw new Error(`Failed to archive required end fixture for ${input.rootAgentId}`);
  }
  const listedRefs = await listArchivedObjects(input.rootAgentId);
  const refs = uniqueArtifacts(
    excludeControlArtifacts(fixtureRef === null ? listedRefs : [...listedRefs, fixtureRef])
  );
  const manifestValue = buildManifestValue({
    rootAgentId: input.rootAgentId,
    refs,
    worldModelMode: input.worldModelMode,
    benchmarkTaskName: input.benchmarkTaskName,
    benchmarkResult: benchmarkResultFromInput(input),
    run: encryptedRunMetadata(endFixture),
    correlations: {
      root_agent_id: input.rootAgentId,
      user_id: endFixture.user_id,
      agent_ids: endFixture.agent_ids,
    },
    finalized: true,
    force: input.force === true,
  });
  const manifest = await archiveJson({
    rootAgentId: input.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: manifestValue,
  });
  if (archiveEnabled() && manifest === null) {
    throw new Error(`Failed to archive required manifest for ${input.rootAgentId}`);
  }
  const publicManifestRef = await writePublicManifest(
    input.rootAgentId,
    refs,
    input.benchmarkTaskName
  );
  log.info('Trace archive finalized', {
    root_agent_id: input.rootAgentId,
    manifest_ref: manifest?.ref ?? null,
    fixture_ref: fixtureRef?.ref ?? null,
  });
  return { manifest, publicManifestRef };
}
