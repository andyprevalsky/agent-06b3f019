import fs from 'node:fs';
import path from 'node:path';
import {
  archiveJson,
  listArchivedObjects,
  storePlainArtifact,
  type ArchivedObjectSummary,
  type StoreResult,
} from './traceArchive';
import {
  FIXTURE_TABLE_ORDER,
  VALID_AGENT_STATUSES,
  type JsonRecord,
  type LegacyBenchmarkRun,
  type LegacyBundle,
  type LegacyTaskResult,
  type TraceArchiveMigrationOptions,
  type TraceArchiveMigrationResult,
  type TraceArchiveMigrationSummary,
} from './traceArchiveMigrationTypes';

export type {
  TraceArchiveMigrationOptions,
  TraceArchiveMigrationResult,
  TraceArchiveMigrationSummary,
} from './traceArchiveMigrationTypes';

/*
Trace archive migration flow:

  legacy benchmark runs + .llm-dumps
        |
        v
  infer root bundle + child agent ids
        |
        v
  write uniform encrypted objects:
    db/start.fixture.json.gz.enc
    db/end.fixture.json.gz.enc
    llm/<dump_id>.json.gz.enc
    benchmark/task-result.json.gz.enc
    manifest.json.gz.enc + manifest.public.json
        |
        v
  future WMH/export/audit code reads the same bundle shape as new runs
*/

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index]);
      }
    })
  );
  return results;
}

function defaultSourceRoot(): string {
  return path.resolve(process.cwd(), '..');
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'legacy';
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function listLlmDumpDirs(llmDumpsDir: string): string[] {
  if (!fs.existsSync(llmDumpsDir)) return [];
  return fs
    .readdirSync(llmDumpsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(llmDumpsDir, entry.name))
    .sort();
}

function collectAgentIdsFromMetadata(value: unknown, ids: Set<string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectAgentIdsFromMetadata(item, ids);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as JsonRecord)) {
    if (
      key === 'subAgentId' ||
      key === 'childAgentId' ||
      key === 'parentAgentId' ||
      key === 'busId' ||
      key.endsWith('AgentId')
    ) {
      if (typeof nested === 'string') ids.add(nested);
    } else if (key === 'subAgentIds' || key === 'childAgentIds' || key.endsWith('AgentIds')) {
      if (Array.isArray(nested)) {
        for (const item of nested) if (typeof item === 'string') ids.add(item);
      }
    }
    collectAgentIdsFromMetadata(nested, ids);
  }
}

function extractTaskAgentIds(task: LegacyTaskResult): Set<string> {
  const ids = new Set<string>();
  if (typeof task.agent_id === 'string' && task.agent_id !== '') ids.add(task.agent_id);
  for (const message of task.logs?.messages ?? [])
    collectAgentIdsFromMetadata(message.metadata, ids);
  for (const event of task.logs?.realtime_logs ?? []) collectAgentIdsFromMetadata(event, ids);
  return ids;
}

function dumpFilesForAgent(llmDumpsDir: string, agentId: string): string[] {
  const dir = path.join(llmDumpsDir, agentId);
  return listJsonFiles(dir);
}

function discoverBundles(
  options: Required<
    Pick<TraceArchiveMigrationOptions, 'runsDir' | 'llmDumpsDir' | 'includeLlmOnly'>
  >
): LegacyBundle[] {
  const bundles: LegacyBundle[] = [];
  const assignedDumpAgents = new Set<string>();

  for (const runPath of listJsonFiles(options.runsDir)) {
    const run = readJsonFile<LegacyBenchmarkRun>(runPath);
    for (const task of run.tasks ?? []) {
      if (typeof task.agent_id !== 'string' || task.agent_id === '') continue;
      const agentIds = extractTaskAgentIds(task);
      agentIds.add(task.agent_id);
      const llmDumpFiles = [...agentIds].flatMap((id) =>
        dumpFilesForAgent(options.llmDumpsDir, id)
      );
      for (const id of agentIds) {
        if (dumpFilesForAgent(options.llmDumpsDir, id).length > 0) assignedDumpAgents.add(id);
      }
      bundles.push({
        rootAgentId: task.agent_id,
        sourceKind: 'benchmark-task',
        sourceLabel: `${run.run_id ?? path.basename(runPath, '.json')}:${task.name ?? task.agent_id}`,
        run,
        runPath,
        task,
        agentIds,
        llmDumpFiles,
      });
    }
  }

  if (options.includeLlmOnly) {
    for (const dir of listLlmDumpDirs(options.llmDumpsDir)) {
      const agentId = path.basename(dir);
      if (assignedDumpAgents.has(agentId)) continue;
      const llmDumpFiles = listJsonFiles(dir);
      if (llmDumpFiles.length === 0) continue;
      bundles.push({
        rootAgentId: agentId,
        sourceKind: 'llm-only',
        sourceLabel: `.llm-dumps/${agentId}`,
        agentIds: new Set([agentId]),
        llmDumpFiles,
      });
    }
  }

  return bundles.sort((a, b) => a.rootAgentId.localeCompare(b.rootAgentId));
}

function normalizeStatus(status: unknown, passed?: boolean): string {
  if (typeof status === 'string' && VALID_AGENT_STATUSES.has(status)) return status;
  if (passed === true) return 'COMPLETED';
  if (passed === false) return 'FAILED';
  return 'COMPLETED';
}

function timestampForBundle(bundle: LegacyBundle): string {
  const taskMessageTime = bundle.task?.logs?.messages?.find(
    (message) => message.created_at
  )?.created_at;
  if (typeof taskMessageTime === 'string') return taskMessageTime;
  if (typeof bundle.run?.timestamp === 'string') return bundle.run.timestamp;
  const firstDump = bundle.llmDumpFiles[0];
  if (firstDump) {
    const match = path.basename(firstDump).match(/^(\d+)/);
    if (match) return new Date(Number(match[1])).toISOString();
  }
  return new Date(0).toISOString();
}

function inferGoal(bundle: LegacyBundle, agentId: string): string {
  if (agentId !== bundle.rootAgentId) return `Legacy migrated sub-agent for ${bundle.rootAgentId}`;
  const firstUser = bundle.task?.logs?.messages?.find((message) => message.role === 'USER');
  if (typeof firstUser?.message === 'string' && firstUser.message.trim() !== '')
    return firstUser.message;
  if (bundle.task?.name) return `Legacy migrated benchmark task ${bundle.task.name}`;
  return `Legacy migrated LLM trace ${bundle.rootAgentId}`;
}

function buildFixture(bundle: LegacyBundle, phase: 'start' | 'end'): JsonRecord {
  const capturedAt = phase === 'start' ? timestampForBundle(bundle) : new Date().toISOString();
  const agentIds = [...bundle.agentIds];
  const userId = `legacy-user-${safePathSegment(bundle.rootAgentId)}`;
  const endStatus = normalizeStatus(bundle.task?.status, bundle.task?.passed);
  const messages = bundle.task?.logs?.messages ?? [];
  const fixtureMessages = phase === 'start' ? messages.slice(0, 1) : messages;
  const toolNames = new Set<string>();
  const toolUsages: JsonRecord[] = [];
  for (const [index, message] of fixtureMessages.entries()) {
    const metadata = (message.metadata ?? {}) as JsonRecord;
    const toolName = typeof metadata.toolName === 'string' ? metadata.toolName : null;
    if (toolName === null) continue;
    toolNames.add(toolName);
    toolUsages.push({
      id: `legacy-tool-usage-${safePathSegment(bundle.rootAgentId)}-${index}`,
      agentId: bundle.rootAgentId,
      toolName,
      totalCostCents: 0,
      usageItems: [
        {
          legacy_migrated: true,
          tool_call_id: metadata.toolCallId ?? null,
          tool_status: metadata.toolStatus ?? null,
          created_at: message.created_at ?? null,
        },
      ],
      createdAt: message.created_at ?? capturedAt,
      userId,
    });
  }
  const tools = [...toolNames].sort().map((toolName) => ({
    id: `legacy-tool-${safePathSegment(toolName)}`,
    name: toolName,
    description: 'Synthetic tool row reconstructed from legacy trace migration.',
    createdAt: capturedAt,
  }));
  return {
    schema_version: 1,
    kind: 'scoped-db-fixture',
    phase,
    captured_at: capturedAt,
    base_image: 'legacy:migrated-unavailable',
    root_agent_id: bundle.rootAgentId,
    user_id: userId,
    agent_ids: agentIds,
    table_order: FIXTURE_TABLE_ORDER,
    restore: {
      strategy: 'delete-scoped-rows-then-insert-in-table-order',
      scope: { root_agent_id: bundle.rootAgentId, user_id: userId, agent_ids: agentIds },
      legacy_migrated: true,
      limitations: [
        'Original production database rows were not available during migration.',
        'Rows were reconstructed from benchmark run JSON, message logs, and .llm-dumps.',
      ],
    },
    rows: {
      User: [
        { id: userId, userId, isAnonymous: true, createdAt: capturedAt, updatedAt: capturedAt },
      ],
      Tool: tools,
      Agent: agentIds.map((agentId) => ({
        id: agentId,
        userId,
        goal: inferGoal(bundle, agentId),
        progress: phase === 'start' ? 0 : bundle.task?.passed === false ? 0 : 1,
        status: phase === 'start' ? 'STARTING_UP' : endStatus,
        statusMessage: bundle.task?.failure_reason ?? null,
        deletedAt: null,
        createdAt: capturedAt,
        updatedAt: capturedAt,
        temporalWorkflowId: null,
        model: 'legacy-migrated',
        contextSize: 0,
        messageCount: fixtureMessages.length,
        tokenCount: 0,
        tokensIn: 0,
        tokensOut: 0,
        parentAgentId: agentId === bundle.rootAgentId ? null : bundle.rootAgentId,
        source: 'WEB',
        depth: agentId === bundle.rootAgentId ? 0 : 1,
        parentWorkflowId: null,
        reasoningMaxTokens: 2048,
        responseSchema: null,
        busId: null,
        toolsInUse: [...toolNames].sort(),
        structuredResponse: null,
        proxyCity: null,
        proxyCountry: null,
        proxyState: null,
        priceLimitCents: 100,
        treeCostCents: Math.round(Number(bundle.task?.cost_cents ?? 0)),
        ownCostCents: Number(bundle.task?.cost_cents ?? 0),
        writeLockEnabled: true,
        fastModeCacheEnabled: false,
        githubRepoUrl: null,
      })),
      AgentTool: tools.map((tool) => ({
        agentId: bundle.rootAgentId,
        toolId: tool.id,
        assignedAt: capturedAt,
      })),
      Verifier: [],
      Message: fixtureMessages.map((message, index) => ({
        id: `legacy-message-${safePathSegment(bundle.rootAgentId)}-${index}`,
        agentId: bundle.rootAgentId,
        timestamp: message.created_at ?? capturedAt,
        text: typeof message.message === 'string' ? message.message : '',
        role: typeof message.role === 'string' ? message.role : 'TOOL',
        createdAt: message.created_at ?? capturedAt,
        metadata: {
          legacy_migrated: true,
          ...(typeof message.metadata === 'object' && message.metadata !== null
            ? message.metadata
            : {}),
        },
        filePointer: null,
      })),
      ToolUsage: toolUsages,
      PurchaseSpend: [],
      AgentAttentionRequest: [],
      UserAuthAssistanceRequest: [],
      BrowserContext: [],
      BrowserSession: [],
      ClaudeCodeSession: [],
      Person: [],
      MessageRecord: [],
      Integration: [],
      EmailIntegrationCredential: [],
      Cookie: [],
      BrowserPassword: [],
      CookieBundle: [],
      SteelSessionAuth: [],
      MintedAccount: [],
      PasskeyCredential: [],
      AgentIdentity: [],
      AgentPhoneMessage: [],
      AgentRunCredentialPropagation: [],
      ToolSideEffect: [],
      SmsSession: [],
      SmsShortcode: [],
    },
  };
}

function llmObjectPath(filePath: string): string {
  const raw = readJsonFile<JsonRecord>(filePath);
  const dumpId =
    typeof raw.dump_id === 'string' && raw.dump_id !== ''
      ? raw.dump_id
      : path.basename(filePath, '.json');
  return `llm/${safePathSegment(dumpId)}.json.gz.enc`;
}

async function archiveLlmDump(bundle: LegacyBundle, filePath: string): Promise<StoreResult | null> {
  const raw = readJsonFile<JsonRecord>(filePath);
  const value = {
    schema_version: 1,
    kind: 'legacy-llm-dump',
    migrated_at: new Date().toISOString(),
    root_agent_id: bundle.rootAgentId,
    source_path: `.llm-dumps/${path.basename(path.dirname(filePath))}/${path.basename(filePath)}`,
    payload: raw,
  };
  return archiveJson({
    rootAgentId: bundle.rootAgentId,
    objectPath: llmObjectPath(filePath),
    value,
  });
}

function publicManifestValue(
  bundle: LegacyBundle,
  refs: ArchivedObjectSummary[],
  artifactCount: number
): JsonRecord {
  return {
    schema_version: 1,
    kind: 'trace-archive-public-manifest',
    root_agent_id: bundle.rootAgentId,
    source_kind: bundle.sourceKind,
    source_label: bundle.sourceLabel,
    benchmark_task: bundle.task?.name ?? null,
    agent_count: bundle.agentIds.size,
    llm_dump_count: bundle.llmDumpFiles.length,
    artifact_count: artifactCount,
    paths: refs.map((ref) => ref.path).sort(),
    legacy_migrated: true,
  };
}

async function migrateBundle(
  bundle: LegacyBundle,
  options: Pick<TraceArchiveMigrationOptions, 'force' | 'dryRun'>
): Promise<TraceArchiveMigrationResult> {
  const existing = await listArchivedObjects(bundle.rootAgentId);
  const hasCompleteBundle = [
    'db/start.fixture.json.gz.enc',
    'db/end.fixture.json.gz.enc',
    'manifest.json.gz.enc',
  ].every((requiredPath) => existing.some((object) => object.path === requiredPath));
  if (hasCompleteBundle && !options.force) {
    return {
      rootAgentId: bundle.rootAgentId,
      sourceKind: bundle.sourceKind,
      sourceLabel: bundle.sourceLabel,
      migrated: false,
      skipped: true,
      reason: 'complete archive bundle already exists',
      agentIds: [...bundle.agentIds],
      llmDumpCount: bundle.llmDumpFiles.length,
      artifactCount: existing.length,
      manifestRef: existing.find((object) => object.path === 'manifest.json.gz.enc')?.ref ?? null,
      publicManifestRef:
        existing.find((object) => object.path === 'manifest.public.json')?.ref ?? null,
    };
  }

  if (options.dryRun) {
    return {
      rootAgentId: bundle.rootAgentId,
      sourceKind: bundle.sourceKind,
      sourceLabel: bundle.sourceLabel,
      migrated: false,
      skipped: true,
      reason: 'dry run',
      agentIds: [...bundle.agentIds],
      llmDumpCount: bundle.llmDumpFiles.length,
      artifactCount: 0,
      manifestRef: null,
      publicManifestRef: null,
    };
  }

  const written: StoreResult[] = [];
  const start = await archiveJson({
    rootAgentId: bundle.rootAgentId,
    objectPath: 'db/start.fixture.json.gz.enc',
    value: buildFixture(bundle, 'start'),
  });
  if (start) written.push(start);
  const end = await archiveJson({
    rootAgentId: bundle.rootAgentId,
    objectPath: 'db/end.fixture.json.gz.enc',
    value: buildFixture(bundle, 'end'),
  });
  if (end) written.push(end);
  if (bundle.task) {
    const taskResult = await archiveJson({
      rootAgentId: bundle.rootAgentId,
      objectPath: `benchmark/${safePathSegment(bundle.run?.run_id ?? 'legacy-run')}-${safePathSegment(
        bundle.task.name ?? bundle.rootAgentId
      )}.json.gz.enc`,
      value: {
        schema_version: 1,
        kind: 'legacy-benchmark-task-result',
        migrated_at: new Date().toISOString(),
        run: {
          run_id: bundle.run?.run_id ?? null,
          timestamp: bundle.run?.timestamp ?? null,
          suite: bundle.run?.suite ?? null,
          base_url: bundle.run?.base_url ?? null,
          summary: bundle.run?.summary ?? null,
        },
        source_path: bundle.runPath ? path.basename(bundle.runPath) : null,
        task: bundle.task,
      },
    });
    if (taskResult) written.push(taskResult);
  }
  for (const filePath of bundle.llmDumpFiles) {
    const result = await archiveLlmDump(bundle, filePath);
    if (result) written.push(result);
  }

  const refs = await listArchivedObjects(bundle.rootAgentId);
  const fullManifest = await archiveJson({
    rootAgentId: bundle.rootAgentId,
    objectPath: 'manifest.json.gz.enc',
    value: {
      ...publicManifestValue(bundle, refs, refs.length),
      run: {
        root_goal: inferGoal(bundle, bundle.rootAgentId),
        status: normalizeStatus(bundle.task?.status, bundle.task?.passed),
        started_at: timestampForBundle(bundle),
        migrated_at: new Date().toISOString(),
      },
      correlations: {
        root_agent_id: bundle.rootAgentId,
        agent_ids: [...bundle.agentIds],
      },
      sensitive: {
        refs,
        source_run_path: bundle.runPath ?? null,
        legacy_fixture_limitations: [
          'Synthetic DB rows were reconstructed from legacy run artifacts.',
          'Original DB fixture rows are unavailable unless separately restored from a database backup.',
        ],
      },
    },
  });
  const finalRefs = await listArchivedObjects(bundle.rootAgentId);
  const publicManifestRef = await storePlainArtifact({
    rootAgentId: bundle.rootAgentId,
    objectPath: 'manifest.public.json',
    body: Buffer.from(
      JSON.stringify(publicManifestValue(bundle, finalRefs, finalRefs.length), null, 2)
    ),
    contentType: 'application/json',
  });

  return {
    rootAgentId: bundle.rootAgentId,
    sourceKind: bundle.sourceKind,
    sourceLabel: bundle.sourceLabel,
    migrated: true,
    skipped: false,
    agentIds: [...bundle.agentIds],
    llmDumpCount: bundle.llmDumpFiles.length,
    artifactCount: finalRefs.length,
    manifestRef: fullManifest?.ref ?? null,
    publicManifestRef,
  };
}

export async function migrateLegacyTraces(
  options: TraceArchiveMigrationOptions = {}
): Promise<TraceArchiveMigrationSummary> {
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot();
  const runsDir = options.runsDir ?? path.join(sourceRoot, 'agents', 'benchmarks', 'runs');
  const llmDumpsDir = options.llmDumpsDir ?? path.join(sourceRoot, '.llm-dumps');
  const bundles = discoverBundles({
    runsDir,
    llmDumpsDir,
    includeLlmOnly: options.includeLlmOnly ?? true,
  });
  const migrationResults = await mapWithConcurrency(
    bundles,
    options.concurrency ?? 6,
    async (bundle): Promise<{ result: TraceArchiveMigrationResult; failed: boolean }> => {
      try {
        return {
          result: await migrateBundle(bundle, {
            force: options.force ?? false,
            dryRun: options.dryRun ?? false,
          }),
          failed: false,
        };
      } catch (error) {
        return {
          result: {
            rootAgentId: bundle.rootAgentId,
            sourceKind: bundle.sourceKind,
            sourceLabel: bundle.sourceLabel,
            migrated: false,
            skipped: false,
            reason: error instanceof Error ? error.message : String(error),
            agentIds: [...bundle.agentIds],
            llmDumpCount: bundle.llmDumpFiles.length,
            artifactCount: 0,
            manifestRef: null,
            publicManifestRef: null,
          },
          failed: true,
        };
      }
    }
  );
  const results = migrationResults.map((item) => item.result);
  const failed = migrationResults.filter((item) => item.failed).length;
  return {
    migrated: results.filter((result) => result.migrated).length,
    skipped: results.filter((result) => result.skipped).length,
    failed,
    results,
  };
}
