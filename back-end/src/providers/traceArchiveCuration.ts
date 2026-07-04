import {
  type ArchivedObjectSummary,
  deleteArchivedBundle,
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
} from './traceArchive';
import { auditArchiveBundle } from './traceArchiveAudit';

const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
  'CANCELLED',
  'CANCELED',
  'PASSED',
  'ERROR',
]);

export interface GoldArchivePolicy {
  requireNonLegacy: boolean;
  requireTerminal: boolean;
  requireFixtures: boolean;
  requireReplayableArtifacts: boolean;
  /**
   * Reject bundles whose manifest records a non-real world-model mode
   * (e.g. simulate). Simulated observations must never feed the corpus the
   * world model grounds on. Shadow runs execute real calls, so they count as
   * real interactions. Legacy bundles without the field predate simulation
   * and are treated as real.
   */
  requireRealWorldInteractions: boolean;
}

export interface ArchiveGoldClassification {
  rootAgentId: string;
  gold: boolean;
  reasons: string[];
  objectCount: number;
  encryptedObjectCount: number;
  decryptedObjectCount: number;
  replayableArtifactCount: number;
  providerArtifactCount: number;
  mediaArtifactCount: number;
  llmTraceCount: number;
  benchmarkTaskName: string | null;
  rootStatus: string | null;
  legacyMigrated: boolean;
  worldModelMode: string | null;
}

export interface CurateTraceArchiveOptions {
  rootAgentIds: string[];
  deleteRejected?: boolean;
  policy?: Partial<GoldArchivePolicy>;
}

export interface CurateTraceArchiveResult {
  deleted: boolean;
  classification: ArchiveGoldClassification;
  deletedObjectCount: number;
}

const DEFAULT_POLICY: GoldArchivePolicy = {
  requireNonLegacy: true,
  requireTerminal: true,
  requireFixtures: true,
  requireReplayableArtifacts: false,
  requireRealWorldInteractions: true,
};

const REAL_WORLD_MODEL_MODES = new Set(['real', 'shadow']);

function policyWithDefaults(policy?: Partial<GoldArchivePolicy>): GoldArchivePolicy {
  return { ...DEFAULT_POLICY, ...(policy ?? {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readEncryptedJson(rootAgentId: string, objectPath: string): Promise<unknown | null> {
  const stored = await readArchivedArtifact({ rootAgentId, objectPath });
  if (stored === null) return null;
  return JSON.parse(decryptAndValidateArtifact(stored).toString('utf8')) as unknown;
}

function pathStartsWithAny(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function replayableArtifactCount(objects: ArchivedObjectSummary[]): number {
  return objects.filter((object) =>
    pathStartsWithAny(object.path, [
      'provider/',
      'media/',
      'browser/',
      'otel/',
      'transitions/',
      'wmh/',
    ])
  ).length;
}

function legacyMarker(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.legacy_migrated === true) return true;
  if (value.source_kind === 'llm-only' || value.source_kind === 'benchmark-task') return true;
  const restore = value.restore;
  if (isRecord(restore) && restore.legacy_migrated === true) return true;
  const sensitive = value.sensitive;
  if (isRecord(sensitive) && Array.isArray(sensitive.legacy_fixture_limitations)) return true;
  return false;
}

function rootStatusFromManifest(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null;
  const benchmarkResult = manifest.benchmark_result;
  if (isRecord(benchmarkResult) && typeof benchmarkResult.status === 'string') {
    return benchmarkResult.status;
  }
  const run = manifest.run;
  if (isRecord(run)) {
    if (typeof run.root_status === 'string') return run.root_status;
    if (typeof run.status === 'string') return run.status;
  }
  return null;
}

function benchmarkTaskFromManifest(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null;
  if (typeof manifest.benchmark_task_name === 'string') return manifest.benchmark_task_name;
  if (typeof manifest.benchmark_task === 'string') return manifest.benchmark_task;
  return null;
}

function worldModelModeFromManifest(manifest: unknown): string | null {
  if (!isRecord(manifest)) return null;
  const mode = manifest.world_model_mode;
  if (typeof mode !== 'string' || mode.trim() === '') return null;
  return mode.trim().toLowerCase();
}

function fixtureLooksReal(fixture: unknown): boolean {
  if (!isRecord(fixture)) return false;
  if (legacyMarker(fixture)) return false;
  if (fixture.kind !== undefined && fixture.kind !== 'scoped-db-fixture') return false;
  return isRecord(fixture.rows) && Array.isArray(fixture.agent_ids);
}

export async function classifyTraceArchiveGold(
  rootAgentId: string,
  policyInput?: Partial<GoldArchivePolicy>
): Promise<ArchiveGoldClassification> {
  const policy = policyWithDefaults(policyInput);
  const audit = await auditArchiveBundle(rootAgentId);
  const objects = await listArchivedObjects(rootAgentId);
  const paths = new Set(objects.map((object) => object.path));
  const reasons: string[] = [];

  if (!audit.ok) {
    for (const missing of audit.missing) reasons.push(`missing:${missing}`);
    for (const invalid of audit.invalid) reasons.push(`invalid:${invalid.path}`);
  }

  const [manifest, startFixture, endFixture] = await Promise.all([
    readEncryptedJson(rootAgentId, 'manifest.json.gz.enc').catch(() => null),
    readEncryptedJson(rootAgentId, 'db/start.fixture.json.gz.enc').catch(() => null),
    readEncryptedJson(rootAgentId, 'db/end.fixture.json.gz.enc').catch(() => null),
  ]);

  const legacyMigrated =
    legacyMarker(manifest) || legacyMarker(startFixture) || legacyMarker(endFixture);
  if (policy.requireNonLegacy && legacyMigrated) reasons.push('legacy-migrated');

  const fixturesPresent =
    paths.has('db/start.fixture.json.gz.enc') && paths.has('db/end.fixture.json.gz.enc');
  if (policy.requireFixtures && !fixturesPresent) reasons.push('missing-fixtures');
  if (
    policy.requireFixtures &&
    (!fixtureLooksReal(startFixture) || !fixtureLooksReal(endFixture))
  ) {
    reasons.push('synthetic-or-invalid-fixtures');
  }

  const rootStatus = rootStatusFromManifest(manifest);
  if (policy.requireTerminal && (rootStatus === null || !TERMINAL_STATUSES.has(rootStatus))) {
    reasons.push(rootStatus === null ? 'missing-terminal-status' : `non-terminal:${rootStatus}`);
  }

  const replayableCount = replayableArtifactCount(objects);
  if (policy.requireReplayableArtifacts && replayableCount === 0) {
    reasons.push('no-replayable-provider-or-media-artifacts');
  }

  // Absent mode = legacy bundle from before simulation existed = real run.
  const worldModelMode = worldModelModeFromManifest(manifest);
  if (
    policy.requireRealWorldInteractions &&
    worldModelMode !== null &&
    !REAL_WORLD_MODEL_MODES.has(worldModelMode)
  ) {
    reasons.push(`simulated-run:${worldModelMode}`);
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    rootAgentId,
    gold: uniqueReasons.length === 0,
    reasons: uniqueReasons,
    objectCount: audit.objectCount,
    encryptedObjectCount: audit.encryptedObjectCount,
    decryptedObjectCount: audit.decryptedObjectCount,
    replayableArtifactCount: replayableCount,
    providerArtifactCount: objects.filter((object) => object.path.startsWith('provider/')).length,
    mediaArtifactCount: objects.filter((object) => object.path.startsWith('media/')).length,
    llmTraceCount: objects.filter((object) => object.path.startsWith('llm')).length,
    benchmarkTaskName: benchmarkTaskFromManifest(manifest),
    rootStatus,
    legacyMigrated,
    worldModelMode,
  };
}

export async function curateTraceArchives(
  options: CurateTraceArchiveOptions
): Promise<CurateTraceArchiveResult[]> {
  const results: CurateTraceArchiveResult[] = [];
  for (const rootAgentId of options.rootAgentIds) {
    const classification = await classifyTraceArchiveGold(rootAgentId, options.policy);
    let deletedObjectCount = 0;
    if (options.deleteRejected === true && !classification.gold) {
      deletedObjectCount = (await deleteArchivedBundle(rootAgentId)).deletedObjectCount;
    }
    results.push({
      deleted: deletedObjectCount > 0,
      classification,
      deletedObjectCount,
    });
  }
  return results;
}
