#!/usr/bin/env tsx
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { startAgentWorkflowExecution } from '../src/providers/temporal';
import { nonLocalDatabaseReason } from '../src/utils/localDatabaseUrl';

type ExportMessage = {
  message_id?: string;
  id?: string;
  timestamp?: string;
  text?: string;
  role?: string;
  metadata?: unknown;
  file_pointer?: unknown;
  filePointer?: unknown;
};

type AgentExport = {
  agent: Record<string, any>;
  messages?: ExportMessage[];
};

type TreeAgentExport = {
  agent_id?: string;
  id?: string;
  parent_agent_id?: string | null;
  parentAgentId?: string | null;
  goal?: string;
  status?: string;
  progress?: number;
  tools_in_use?: string[];
  toolsInUse?: string[];
  message_count?: number;
  messageCount?: number;
  output_schema?: unknown;
  responseSchema?: unknown;
  structured_output?: unknown;
  structuredResponse?: unknown;
  tree_cost_cents?: number;
  treeCostCents?: number;
};

type AgentTreeExport = {
  agents: TreeAgentExport[];
};

type Options = {
  sourceJson: string;
  treeJson?: string;
  taskName?: string;
  userId?: string;
  throughIndex?: number;
  fastModeCacheEnabled: boolean;
  priceLimitCents?: number;
  taskQueue?: string;
  noStart: boolean;
  startPhase: 'execute' | 'execute_dag_resume';
  out?: string;
};

const prisma = new PrismaClient();

function usage(): never {
  console.log(`usage: npx tsx scripts/create-agent-checkpoint.ts --source-json PATH [options]

Clone an exported agent transcript into the local DB through a checkpoint message
and optionally start AgentWorkflow at execute_dag_resume (or --start-phase execute
for a post-completion chat re-escalation replay).

Options:
  --through-index N             Inclusive message index to clone. When omitted,
                                defaults to the last finished
                                spawn_general_purpose_agent_for_each.
  --tree-json PATH              Optional exported agent tree. Child agents are
                                cloned under the new checkpoint root but not run.
  --task-name NAME              Benchmark task name to record in the manifest.
  --user-id UUID                User id for exports that omit it. Defaults to
                                BENCHMARK_USER_ID, TEST_USER_ID, or the dev benchmark user.
  --fast-mode-cache true|false  DEMO cache flag for the resumed workflow. Default false.
  --price-limit-cents N         Override cloned price limit.
  --task-queue NAME             Temporal task queue. Defaults to TEMPORAL_TASK_QUEUE.
  --no-start                    Clone only, do not start Temporal.
  --start-phase execute|execute_dag_resume
                                Workflow start phase when Temporal is started.
                                Default execute_dag_resume. Use execute to replay
                                a chat re-escalation after a completed run.
  --out PATH                    Manifest path. Default .context/benchmark-checkpoints/<id>.json
`);
  process.exit(0);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    sourceJson: '',
    fastModeCacheEnabled: false,
    noStart: false,
    startPhase: 'execute_dag_resume',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--help' || arg === '-h') usage();
    if (arg === '--source-json') opts.sourceJson = next();
    else if (arg === '--tree-json') opts.treeJson = next();
    else if (arg === '--task-name') opts.taskName = next();
    else if (arg === '--user-id') opts.userId = next();
    else if (arg === '--through-index') opts.throughIndex = Number.parseInt(next(), 10);
    else if (arg === '--fast-mode-cache') opts.fastModeCacheEnabled = next() === 'true';
    else if (arg === '--price-limit-cents') opts.priceLimitCents = Number.parseInt(next(), 10);
    else if (arg === '--task-queue') opts.taskQueue = next();
    else if (arg === '--no-start') opts.noStart = true;
    else if (arg === '--start-phase') {
      const value = next();
      if (value !== 'execute' && value !== 'execute_dag_resume') {
        throw new Error('--start-phase must be execute or execute_dag_resume');
      }
      opts.startPhase = value;
    } else if (arg === '--out') opts.out = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.sourceJson) throw new Error('--source-json is required');
  if (
    opts.throughIndex !== undefined &&
    (!Number.isInteger(opts.throughIndex) || opts.throughIndex < 0)
  ) {
    throw new Error('--through-index must be a non-negative integer');
  }
  if (
    opts.priceLimitCents !== undefined &&
    (!Number.isInteger(opts.priceLimitCents) || opts.priceLimitCents <= 0)
  ) {
    throw new Error('--price-limit-cents must be a positive integer');
  }
  return opts;
}

function pick<T>(obj: Record<string, any>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key] as T;
  }
  return undefined;
}

function assertLocalDatabase() {
  if (process.env.ALLOW_PROD_CHECKPOINT_CLONE === 'true') return;
  const reason = nonLocalDatabaseReason(process.env.DATABASE_URL);
  if (reason) {
    throw new Error(
      `Refusing to clone checkpoint: ${reason}. ` +
        'Set ALLOW_PROD_CHECKPOINT_CLONE=true only if you intend this.'
    );
  }
}

function loadExport(path: string): AgentExport {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  const agent = raw.agent;
  const messages = raw.messages || raw.agent?.messages;
  if (!agent || !Array.isArray(messages)) {
    throw new Error('Source JSON must contain { agent, messages }');
  }
  return { agent, messages };
}

function loadTreeExport(path: string): AgentTreeExport {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(raw.agents)) {
    throw new Error('Tree JSON must contain { agents }');
  }
  return { agents: raw.agents };
}

function isForEachBoundary(message: ExportMessage): boolean {
  const metadata = (message.metadata || {}) as Record<string, any>;
  return (
    metadata.toolName === 'spawn_general_purpose_agent_for_each' &&
    metadata.toolStatus === 'FINISHED'
  );
}

function isForEachChildRootRow(message: ExportMessage): boolean {
  const metadata = (message.metadata || {}) as Record<string, any>;
  return metadata.toolName === 'spawn_general_purpose_agent';
}

function findCheckpointIndex(messages: ExportMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isForEachBoundary(messages[i])) return i;
  }
  throw new Error('Could not find finished spawn_general_purpose_agent_for_each message');
}

function rewriteIds(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, idMap));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = rewriteIds(child, idMap);
    }
    return out;
  }
  return value;
}

function exportAgentId(agent: Record<string, any>): string {
  const id = pick<string>(agent, 'agent_id', 'id');
  if (!id) throw new Error('Source agent is missing agent_id/id');
  return id;
}

function exportTreeAgentId(agent: TreeAgentExport): string {
  const id = pick<string>(agent as Record<string, any>, 'agent_id', 'id');
  if (!id) throw new Error('Tree agent is missing agent_id/id');
  return id;
}

function exportTreeParentId(agent: TreeAgentExport): string | null {
  return pick<string>(agent as Record<string, any>, 'parent_agent_id', 'parentAgentId') || null;
}

function coerceAgentStatus(status: string | undefined): string {
  if (
    status &&
    [
      'STARTING_UP',
      'ACTIVE',
      'PAUSED',
      'COMPLETED',
      'FAILED',
      'OUT_OF_CREDITS',
      'COST_LIMIT_REACHED',
    ].includes(status)
  ) {
    return status;
  }
  return 'COMPLETED';
}

function computeTreeDepth(
  oldAgentId: string,
  oldRootId: string,
  parentById: Map<string, string | null>,
  memo: Map<string, number>
): number {
  const existing = memo.get(oldAgentId);
  if (existing !== undefined) return existing;

  const parentId = parentById.get(oldAgentId);
  if (!parentId || parentId === oldRootId) {
    memo.set(oldAgentId, 1);
    return 1;
  }
  if (!parentById.has(parentId)) {
    throw new Error(`Tree agent ${oldAgentId} references missing parent ${parentId}`);
  }
  const depth = computeTreeDepth(parentId, oldRootId, parentById, memo) + 1;
  memo.set(oldAgentId, depth);
  return depth;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertLocalDatabase();

  const source = loadExport(opts.sourceJson);
  const sourceAgent = source.agent;
  const sourceMessages = source.messages || [];
  const throughIndex = opts.throughIndex ?? findCheckpointIndex(sourceMessages);
  if (throughIndex >= sourceMessages.length) {
    throw new Error(
      `--through-index ${throughIndex} exceeds message count ${sourceMessages.length}`
    );
  }
  if (opts.throughIndex === undefined && !isForEachBoundary(sourceMessages[throughIndex])) {
    throw new Error(`Message ${throughIndex} is not a finished for_each boundary`);
  }

  const oldAgentId = exportAgentId(sourceAgent);
  const newAgentId = randomUUID();
  const idMap = new Map<string, string>([[oldAgentId, newAgentId]]);
  const treeExport = opts.treeJson ? loadTreeExport(opts.treeJson) : null;
  const treeAgents = (treeExport?.agents || []).filter(
    (agent) => exportTreeAgentId(agent) !== oldAgentId
  );
  for (const treeAgent of treeAgents) {
    idMap.set(exportTreeAgentId(treeAgent), randomUUID());
  }
  const userId =
    pick<string>(sourceAgent, 'user_id', 'userId') ||
    opts.userId ||
    process.env.BENCHMARK_USER_ID ||
    process.env.TEST_USER_ID ||
    '1f85ff25-6e29-4c1b-8739-f917bd101a30';
  const goal = pick<string>(sourceAgent, 'goal');
  if (!goal) throw new Error('Source agent is missing goal');

  const verifierType = pick<string>(sourceAgent.verifier || {}, 'type') || 'FLOAT_LLM_JUDGE';
  const model = pick<string>(sourceAgent, 'model') || 'rose-labs/rose-1-ultra';
  const reasoningMaxTokens =
    pick<number>(sourceAgent, 'reasoning_max_tokens', 'reasoningMaxTokens') || 2048;
  const priceLimitCents =
    opts.priceLimitCents ??
    pick<number>(sourceAgent, 'price_limit_cents', 'priceLimitCents') ??
    100;
  const sourceKind = pick<string>(sourceAgent, 'source') || 'WEB';
  const responseSchema = pick<unknown>(sourceAgent, 'response_schema', 'responseSchema') ?? null;
  const structuredResponse =
    pick<unknown>(sourceAgent, 'structured_output', 'structuredResponse') ?? null;
  const progress = pick<number>(sourceAgent, 'progress') ?? 0;
  const statusMessage = pick<string>(sourceAgent, 'status_message', 'statusMessage') ?? null;
  const writeLockEnabled =
    pick<boolean>(sourceAgent, 'write_lock_enabled', 'writeLockEnabled') ?? true;
  const taskQueue = opts.taskQueue || process.env.TEMPORAL_TASK_QUEUE;
  if (!opts.noStart && !taskQueue)
    throw new Error('TEMPORAL_TASK_QUEUE is required unless --no-start is used');

  const checkpointMessages = sourceMessages.slice(0, throughIndex + 1);
  const shouldDropForEachChildRows =
    treeAgents.length > 0 && isForEachBoundary(checkpointMessages[checkpointMessages.length - 1]);
  const messagesToClone = shouldDropForEachChildRows
    ? checkpointMessages.filter(
        (message, index) =>
          index === checkpointMessages.length - 1 || !isForEachChildRootRow(message)
      )
    : checkpointMessages;
  const droppedForEachChildMessageCount = checkpointMessages.length - messagesToClone.length;
  const parentByTreeId = new Map<string, string | null>();
  for (const treeAgent of treeAgents) {
    parentByTreeId.set(exportTreeAgentId(treeAgent), exportTreeParentId(treeAgent));
  }
  const depthMemo = new Map<string, number>();
  const treeAgentsByDepth = [...treeAgents]
    .map((treeAgent) => ({
      agent: treeAgent,
      oldId: exportTreeAgentId(treeAgent),
      depth: computeTreeDepth(exportTreeAgentId(treeAgent), oldAgentId, parentByTreeId, depthMemo),
    }))
    .sort((a, b) => a.depth - b.depth);

  await prisma.$transaction(async (tx) => {
    await tx.agent.create({
      data: {
        id: newAgentId,
        userId,
        goal,
        status: opts.noStart ? 'PAUSED' : 'ACTIVE',
        temporalWorkflowId: opts.noStart ? null : newAgentId,
        model,
        source: sourceKind,
        reasoningMaxTokens,
        responseSchema: responseSchema as any,
        structuredResponse: structuredResponse as any,
        progress,
        statusMessage,
        priceLimitCents,
        writeLockEnabled,
        fastModeCacheEnabled: opts.fastModeCacheEnabled,
        depth: 0,
        busId: newAgentId,
        messageCount: messagesToClone.length,
        ownCostCents: 0,
        treeCostCents: 0,
      },
    });
    await tx.verifier.create({
      data: {
        agentId: newAgentId,
        type: verifierType as any,
      },
    });
    await tx.message.createMany({
      data: messagesToClone.map((message) => ({
        id: randomUUID(),
        agentId: newAgentId,
        timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
        text: message.text || '',
        role: (message.role || 'TOOL') as any,
        metadata: message.metadata ? (rewriteIds(message.metadata, idMap) as any) : undefined,
        filePointer: (message.file_pointer ?? message.filePointer ?? undefined) as any,
      })),
    });
    for (const { agent: treeAgent, oldId, depth } of treeAgentsByDepth) {
      const clonedId = idMap.get(oldId);
      if (!clonedId) throw new Error(`Missing cloned id for tree agent ${oldId}`);
      const oldParentId = exportTreeParentId(treeAgent);
      const parentAgentId = oldParentId ? idMap.get(oldParentId) : newAgentId;
      if (!parentAgentId) {
        throw new Error(`Tree agent ${oldId} references missing parent ${oldParentId}`);
      }
      await tx.agent.create({
        data: {
          id: clonedId,
          userId,
          goal: treeAgent.goal || '',
          status: coerceAgentStatus(treeAgent.status) as any,
          progress: typeof treeAgent.progress === 'number' ? treeAgent.progress : 1,
          parentAgentId,
          model,
          source: sourceKind,
          reasoningMaxTokens,
          responseSchema: (treeAgent.output_schema ?? treeAgent.responseSchema ?? null) as any,
          structuredResponse: (treeAgent.structured_output ??
            treeAgent.structuredResponse ??
            null) as any,
          priceLimitCents,
          writeLockEnabled,
          fastModeCacheEnabled: opts.fastModeCacheEnabled,
          depth,
          busId: newAgentId,
          toolsInUse: treeAgent.tools_in_use || treeAgent.toolsInUse || [],
          messageCount: treeAgent.message_count ?? treeAgent.messageCount ?? 0,
          ownCostCents: 0,
          treeCostCents: 0,
        },
      });
      await tx.verifier.create({
        data: {
          agentId: clonedId,
          type: verifierType as any,
        },
      });
    }
  });

  let workflowId: string | null = null;
  if (!opts.noStart) {
    const execution = await startAgentWorkflowExecution({
      agentId: newAgentId,
      userId,
      goal,
      model,
      reasoningMaxTokens,
      verifier: { type: verifierType },
      taskQueue,
      busId: newAgentId,
      startPhase: opts.startPhase as any,
      priceLimitCents,
      fastModeCacheEnabled: opts.fastModeCacheEnabled,
    });
    await prisma.agent.updateMany({
      where: { id: newAgentId, temporalWorkflowId: execution.workflowId },
      data: { temporalFirstExecutionRunId: execution.firstExecutionRunId },
    });
    workflowId = execution.workflowId;
  }

  const manifestPath =
    opts.out ||
    resolve(process.cwd(), '..', '.context', 'benchmark-checkpoints', `${newAgentId}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest = {
    agent_id: newAgentId,
    task_name: opts.taskName || null,
    source_agent_id: oldAgentId,
    source_json: resolve(opts.sourceJson),
    tree_json: opts.treeJson ? resolve(opts.treeJson) : null,
    through_index: throughIndex,
    cloned_message_count: messagesToClone.length,
    dropped_for_each_child_message_count: droppedForEachChildMessageCount,
    cloned_tree_agent_count: treeAgents.length,
    task_queue: taskQueue || null,
    workflow_id: workflowId,
    start_phase: opts.noStart ? null : opts.startPhase,
    fast_mode_cache_enabled: opts.fastModeCacheEnabled,
    price_limit_cents: priceLimitCents,
    created_at: new Date().toISOString(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`agent_id=${newAgentId}`);
  console.log(`manifest=${manifestPath}`);
  console.log(`checkpoint_index=${throughIndex}`);
  console.log(`cloned_messages=${messagesToClone.length}`);
  console.log(`dropped_for_each_child_messages=${droppedForEachChildMessageCount}`);
  console.log(`cloned_tree_agents=${treeAgents.length}`);
  console.log(`fast_mode_cache_enabled=${opts.fastModeCacheEnabled}`);
  if (workflowId) console.log(`workflow_id=${workflowId}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
