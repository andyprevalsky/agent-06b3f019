import { Prisma, type AgentStatus } from '@prisma/client';
import { prisma } from './database';
import { getTemporalClient } from './temporal';

const TERMINAL_AGENT_STATUSES: AgentStatus[] = ['COMPLETED', 'FAILED'];

export interface WorkflowDeploymentCandidate {
  agentId: string;
  workflowId: string;
  status?: AgentStatus;
}

export interface WorkflowDeploymentOutcome extends WorkflowDeploymentCandidate {
  outcome: 'validated' | 'prepared' | 'migrated' | 'skipped' | 'failed';
  error?: string;
}

export interface WorkflowDeploymentPreparation<T> {
  outcome: 'prepared';
  prepared: T;
}

export interface WorkflowDeploymentSkip {
  outcome: 'skipped';
}

export interface WorkflowDeploymentCutoverDependencies<T> {
  preflight: (
    candidate: WorkflowDeploymentCandidate
  ) => Promise<{ outcome: 'ready' } | WorkflowDeploymentSkip>;
  prepare: (
    candidate: WorkflowDeploymentCandidate
  ) => Promise<WorkflowDeploymentPreparation<T> | WorkflowDeploymentSkip>;
  activate: () => Promise<void>;
  start: (candidate: WorkflowDeploymentCandidate, prepared: T) => Promise<{ workflowId: string }>;
  waitUntilReady: (candidate: WorkflowDeploymentCandidate, workflowId: string) => Promise<void>;
}

export interface WorkflowDeploymentCutoverResult {
  outcomes: WorkflowDeploymentOutcome[];
  activated: boolean;
  haltedAfter: 'preflight' | 'prepare' | 'activation' | 'canary' | null;
  activationError?: string;
}

interface WorkflowReplacementBootstrapWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  readState?: (agentId: string) => Promise<{
    temporalWorkflowId: string | null;
    workflowReplacementToken: string | null;
    status: AgentStatus;
    statusMessage: string | null;
  } | null>;
  requireInitialized?: boolean;
  readInitialized?: (workflowId: string) => Promise<boolean>;
}

/**
 * Freeze the exact set of pre-deploy root executions before starting cutover.
 * Descendants are intentionally handled by the root replacement so the parent
 * LLM observes terminal deployment errors and decides what work to retry.
 */
export async function snapshotOpenRootWorkflows(
  snapshotAt = new Date()
): Promise<WorkflowDeploymentCandidate[]> {
  const agents = await prisma.agent.findMany({
    where: {
      createdAt: { lte: snapshotAt },
      deletedAt: null,
      parentAgentId: null,
      temporalWorkflowId: { not: null },
      OR: [
        { status: { notIn: TERMINAL_AGENT_STATUSES } },
        { status: 'FAILED', workflowReplacementToken: { not: null } },
      ],
    },
    orderBy: { id: 'asc' },
    select: { id: true, temporalWorkflowId: true, status: true },
  });
  return agents.flatMap((agent) =>
    agent.temporalWorkflowId === null
      ? []
      : [{ agentId: agent.id, workflowId: agent.temporalWorkflowId, status: agent.status }]
  );
}

/** Refuse activation if an orphan/late descendant escaped every root cleanup. */
export async function assertNoUnsafeOpenDescendantWorkflows(
  rootAgentIds?: string[]
): Promise<void> {
  const unsafe =
    rootAgentIds === undefined
      ? await prisma.agent.findMany({
          where: {
            deletedAt: null,
            parentAgentId: { not: null },
            OR: [
              { temporalWorkflowStartPending: true },
              {
                temporalWorkflowId: { not: null },
                status: { notIn: TERMINAL_AGENT_STATUSES },
              },
            ],
          },
          orderBy: { id: 'asc' },
          take: 20,
          select: {
            id: true,
            temporalWorkflowId: true,
            temporalWorkflowStartPending: true,
          },
        })
      : rootAgentIds.length === 0
        ? []
        : await prisma.$queryRaw<
            Array<{
              id: string;
              temporalWorkflowId: string | null;
              temporalWorkflowStartPending: boolean;
            }>
          >(Prisma.sql`
            WITH RECURSIVE descendants AS (
              SELECT child.*
              FROM "Agent" child
              WHERE child."parentAgentId" IN (${Prisma.join(rootAgentIds)})
                AND child."deletedAt" IS NULL

              UNION ALL

              SELECT child.*
              FROM "Agent" child
              INNER JOIN descendants parent ON child."parentAgentId" = parent.id
              WHERE child."deletedAt" IS NULL
            )
            SELECT id, "temporalWorkflowId", "temporalWorkflowStartPending"
            FROM descendants
            WHERE "temporalWorkflowStartPending" = true
               OR (
                 "temporalWorkflowId" IS NOT NULL
                 AND status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
               )
            ORDER BY id ASC
            LIMIT 20
          `);
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing worker activation while ${unsafe.length}${unsafe.length === 20 ? '+' : ''} open descendant workflow row(s) remain: ${unsafe.map((row) => `${row.id}=${row.temporalWorkflowId}`).join(', ')}`
    );
  }
}

export async function migrateWorkflowCandidates(
  candidates: WorkflowDeploymentCandidate[],
  migrate: (candidate: WorkflowDeploymentCandidate) => Promise<WorkflowDeploymentOutcome>,
  concurrency: number
): Promise<WorkflowDeploymentOutcome[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Migration concurrency must be an integer between 1 and 100');
  }
  const outcomes = new Array<WorkflowDeploymentOutcome>(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      try {
        outcomes[index] = await migrate(candidate);
      } catch (error) {
        outcomes[index] = {
          ...candidate,
          outcome: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, candidates.length)) }, worker)
  );
  return outcomes;
}

/**
 * Execute the deploy cutover in explicit safety phases.
 *
 * Every frozen history is sealed before activation. The candidate build cannot
 * poll the shared queue until `activate` succeeds, so it never sees an old
 * history. Canary readiness is checked before any remaining replacement starts.
 */
export async function runWorkflowDeploymentCutover<T>(
  candidates: WorkflowDeploymentCandidate[],
  dependencies: WorkflowDeploymentCutoverDependencies<T>,
  options: { concurrency: number; canaryCount: number }
): Promise<WorkflowDeploymentCutoverResult> {
  if (!Number.isInteger(options.canaryCount) || options.canaryCount < 1) {
    throw new Error('Migration canary count must be a positive integer');
  }

  const outcomes = await migrateWorkflowCandidates(
    candidates,
    async (candidate) => {
      const result = await dependencies.preflight(candidate);
      if (result.outcome === 'skipped') return { ...candidate, outcome: 'skipped' };
      return { ...candidate, outcome: 'validated' };
    },
    options.concurrency
  );
  if (outcomes.some((outcome) => outcome.outcome === 'failed')) {
    return { outcomes, activated: false, haltedAfter: 'preflight' };
  }

  const preparedByAgent = new Map<string, T>();
  const validatedIndexes = outcomes.flatMap((outcome, index) =>
    outcome.outcome === 'validated' ? [index] : []
  );
  const preparationOutcomes = await migrateWorkflowCandidates(
    validatedIndexes.map((index) => candidates[index]),
    async (candidate) => {
      const result = await dependencies.prepare(candidate);
      if (result.outcome === 'skipped') return { ...candidate, outcome: 'skipped' };
      preparedByAgent.set(candidate.agentId, result.prepared);
      return { ...candidate, outcome: 'prepared' };
    },
    options.concurrency
  );
  validatedIndexes.forEach((index, outcomeIndex) => {
    outcomes[index] = preparationOutcomes[outcomeIndex];
  });
  if (outcomes.some((outcome) => outcome.outcome === 'failed')) {
    return { outcomes, activated: false, haltedAfter: 'prepare' };
  }

  try {
    await dependencies.activate();
  } catch (error) {
    return {
      outcomes,
      activated: false,
      haltedAfter: 'activation',
      activationError: error instanceof Error ? error.message : String(error),
    };
  }

  const preparedIndexes = outcomes.flatMap((outcome, index) =>
    outcome.outcome === 'prepared' ? [index] : []
  );
  const migratePrepared = async (index: number): Promise<WorkflowDeploymentOutcome> => {
    const candidate = candidates[index];
    const prepared = preparedByAgent.get(candidate.agentId);
    if (prepared === undefined) throw new Error(`${candidate.agentId}: prepared state was lost`);
    const started = await dependencies.start(candidate, prepared);
    await dependencies.waitUntilReady(candidate, started.workflowId);
    return { ...candidate, outcome: 'migrated' };
  };

  const canaryIndexes = selectCanaryIndexes(candidates, preparedIndexes, options.canaryCount);
  for (const index of canaryIndexes) {
    try {
      outcomes[index] = await migratePrepared(index);
    } catch (error) {
      outcomes[index] = {
        ...candidates[index],
        outcome: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
      return { outcomes, activated: true, haltedAfter: 'canary' };
    }
  }

  const canarySet = new Set(canaryIndexes);
  const bulkIndexes = preparedIndexes.filter((index) => !canarySet.has(index));
  const bulkOutcomes = await migrateWorkflowCandidates(
    bulkIndexes.map((index) => candidates[index]),
    async (candidate) => {
      const index = candidates.indexOf(candidate);
      return migratePrepared(index);
    },
    options.concurrency
  );
  bulkIndexes.forEach((index, outcomeIndex) => {
    outcomes[index] = bulkOutcomes[outcomeIndex];
  });
  return { outcomes, activated: true, haltedAfter: null };
}

function selectCanaryIndexes(
  candidates: WorkflowDeploymentCandidate[],
  preparedIndexes: number[],
  canaryCount: number
): number[] {
  const selected: number[] = [];
  for (const status of [
    'ACTIVE',
    'PAUSED',
    'COST_LIMIT_REACHED',
    'OUT_OF_CREDITS',
    'STARTING_UP',
  ] satisfies AgentStatus[]) {
    const match = preparedIndexes.find(
      (index) => candidates[index].status === status && !selected.includes(index)
    );
    if (match !== undefined) selected.push(match);
    if (selected.length >= canaryCount) return selected;
  }
  for (const index of preparedIndexes) {
    if (!selected.includes(index)) selected.push(index);
    if (selected.length >= canaryCount) break;
  }
  return selected;
}

/**
 * A Temporal start acknowledgement only proves that the server accepted the
 * execution. Wait until the candidate atomically persists restored state and
 * clears its generation-fenced claim before counting it as durable READY.
 */
export async function waitForWorkflowReplacementBootstrap(
  agentId: string,
  workflowId: string,
  options: WorkflowReplacementBootstrapWaitOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Bootstrap timeout must be positive');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Bootstrap poll interval must be positive');
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const readState =
    options.readState ??
    ((id: string) =>
      prisma.agent.findUnique({
        where: { id },
        select: {
          temporalWorkflowId: true,
          workflowReplacementToken: true,
          status: true,
          statusMessage: true,
        },
      }));
  const readInitialized =
    options.readInitialized ??
    (async (id: string) => {
      const temporalClient = await getTemporalClient();
      return temporalClient.workflow.getHandle(id).query<boolean>('deployment_initialized_query');
    });
  const deadline = now() + timeoutMs;

  while (true) {
    const state = await readState(agentId);
    if (state === null) throw new Error(`${agentId}: agent disappeared before durable readiness`);
    if (state.temporalWorkflowId !== workflowId) {
      throw new Error(
        `${agentId}: workflow advanced before durable readiness (expected ${workflowId}, got ${state.temporalWorkflowId ?? 'null'})`
      );
    }
    if (state.status === 'FAILED') {
      throw new Error(
        `${agentId}: candidate failed before durable readiness${state.statusMessage ? `: ${state.statusMessage}` : ''}`
      );
    }
    if (state.workflowReplacementToken === null) {
      if (!['ACTIVE', 'PAUSED', 'COST_LIMIT_REACHED', 'OUT_OF_CREDITS'].includes(state.status)) {
        throw new Error(
          `${agentId}: candidate acknowledged bootstrap before durable readiness (status ${state.status})`
        );
      }
      if (!options.requireInitialized || state.status !== 'ACTIVE') return;
      try {
        if (await readInitialized(workflowId)) return;
      } catch {
        // A candidate can briefly be between bootstrap acknowledgement and
        // query-handler availability. Stay inside the same bounded wait.
      }
    }
    if (now() >= deadline) {
      throw new Error(`${agentId}: candidate did not bootstrap within ${timeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}
