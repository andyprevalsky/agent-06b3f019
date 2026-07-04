import { createLogger } from './logger';
import { collectFixture } from './traceArchiveFixture';
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
  const fixture = await collectFixture(input.agentId, 'start');
  const result = await archiveJson({
    rootAgentId: input.agentId,
    objectPath: 'db/start.fixture.json.gz.enc',
    value: fixture,
  });
  return { fixture: result };
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
  const refs = uniqueArtifacts(fixtureRef === null ? listedRefs : [...listedRefs, fixtureRef]);
  const manifestValue = {
    ...publicManifest(input.rootAgentId, refs, input.benchmarkTaskName),
    world_model_mode: normalizedWorldModelMode(input.worldModelMode),
    benchmark_result:
      input.benchmarkPassed === undefined && input.benchmarkStatus === undefined
        ? null
        : {
            passed: input.benchmarkPassed ?? null,
            status: input.benchmarkStatus ?? null,
            failure_reason: input.failureReason ?? null,
          },
    run: encryptedRunMetadata(endFixture),
    correlations: {
      root_agent_id: input.rootAgentId,
      user_id: endFixture.user_id,
      agent_ids: endFixture.agent_ids,
    },
    sensitive: {
      ...encryptedManifestIndex(refs),
      force: input.force === true,
    },
  };
  const manifest = await archiveJson({
    rootAgentId: input.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: manifestValue,
  });
  if (archiveEnabled() && manifest === null) {
    throw new Error(`Failed to archive required manifest for ${input.rootAgentId}`);
  }
  let publicManifestRef: string | null = null;
  if (TRACE_ARCHIVE_PUBLIC_MANIFEST) {
    const publicValue = publicManifest(input.rootAgentId, refs, input.benchmarkTaskName);
    publicManifestRef = await storePlainArtifact({
      rootAgentId: input.rootAgentId,
      objectPath: 'manifest.public.json',
      body: Buffer.from(JSON.stringify(publicValue, null, 2)),
      contentType: 'application/json',
    });
    if (archiveEnabled() && publicManifestRef === null) {
      throw new Error(`Failed to archive required public manifest for ${input.rootAgentId}`);
    }
  }
  log.info('Trace archive finalized', {
    root_agent_id: input.rootAgentId,
    manifest_ref: manifest?.ref ?? null,
    fixture_ref: fixtureRef?.ref ?? null,
  });
  return { manifest, publicManifestRef };
}
