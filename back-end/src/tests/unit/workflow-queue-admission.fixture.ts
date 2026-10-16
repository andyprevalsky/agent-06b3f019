import assert from 'node:assert/strict';
import { Metadata } from '@grpc/grpc-js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, type ConnectionLike } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import * as provider from '../../providers/temporal';
import { prisma } from '../../providers/database';
type AgentRow = Record<string, unknown> & {
  id: string;
  temporalWorkflowId: string | null;
  temporalFirstExecutionRunId: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  status: string;
};
type EffectRow = {
  operationKey?: string;
  externalId?: string;
  request: Record<string, unknown>;
  response?: unknown;
  status?: string;
};
type StartRequest = temporal.api.workflowservice.v1.IStartWorkflowExecutionRequest;

export const SOURCE = 'navi-agent-tasks@source';
export const TARGET = 'navi-agent-tasks@target';
export const CONTROL = 'deployment:temporal-workflow-admission';
const copy = <T>(value: T): T => structuredClone(value);
export function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function matches(row: AgentRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR')
      return (value as Record<string, unknown>[]).some((item) => matches(row, item));
    if (value !== null && typeof value === 'object') {
      if ('in' in value) return (value.in as unknown[]).includes(row[key]);
      if ('notIn' in value) return !(value.notIn as unknown[]).includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      throw new Error(`Unsupported fixture predicate ${key}`);
    }
    return row[key] === value;
  });
}

export function fixture() {
  const agents = new Map<string, AgentRow>();
  const effects = new Map<string, EffectRow>([
    [
      CONTROL,
      {
        request: {
          version: 1,
          phase: 'TRACKING',
          attempt: 'attempt-1',
          installedAt: '2026-10-16T00:00:00Z',
          sourceQueue: SOURCE,
          targetQueue: TARGET,
        },
      },
    ],
  ]);
  const writes: string[] = [];
  const tx = {
    $executeRaw: async () => {
      writes.push('admission-lock');
    },
    $queryRaw: async () => {
      writes.push('generation-lock');
      return [];
    },
    agent: {
      updateMany: async ({
        where,
        data,
      }: {
        where: Partial<AgentRow>;
        data: Partial<AgentRow>;
      }) => {
        const row = agents.get(where.id!);
        if (!row || !matches(row, where)) return { count: 0 };
        Object.assign(row, copy(data));
        return { count: 1 };
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        copy(agents.get(where.id) ?? null),
      update: async ({ where, data }: { where: { id: string }; data: Partial<AgentRow> }) => {
        const row = agents.get(where.id)!;
        Object.assign(row, copy(data));
        writes.push(`agent:${where.id}`);
        return copy(row);
      },
    },
    toolSideEffect: {
      findMany: async ({
        where,
      }: {
        where: { externalId: string; AND: { request: { path: string[]; equals: string } }[] };
      }) =>
        [...effects.values()]
          .filter(
            (row) =>
              row.externalId === where.externalId &&
              where.AND.every((part) => row.request[part.request.path[0]] === part.request.equals)
          )
          .map((row) => ({
            operationKey: row.operationKey,
            status: row.status,
            request: copy(row.request),
          }))
          .sort((a, b) => String(a.operationKey).localeCompare(String(b.operationKey))),
      findFirst: async ({
        where,
      }: {
        where: {
          externalId: string;
          AND: { request: { path: string[]; equals: string } }[];
          OR: { status: string; request?: { path: string[]; equals: string } }[];
        };
      }) =>
        [...effects.values()].find(
          (row) =>
            row.externalId === where.externalId &&
            where.AND.every((part) => row.request[part.request.path[0]] === part.request.equals) &&
            where.OR.some(
              (option) =>
                row.status === option.status &&
                (!option.request || row.request[option.request.path[0]] === option.request.equals)
            )
        ) ?? null,
      findUnique: async ({ where }: { where: { operationKey: string } }) =>
        copy(effects.get(where.operationKey) ?? null),
      create: async ({ data }: { data: EffectRow & { operationKey: string } }) => {
        assert(!effects.has(data.operationKey));
        effects.set(data.operationKey, copy(data));
        writes.push(data.operationKey);
        return copy(data);
      },
      update: async ({
        where,
        data,
      }: {
        where: { operationKey: string };
        data: Partial<EffectRow>;
      }) => {
        const row = effects.get(where.operationKey);
        assert(row);
        Object.assign(row, copy(data));
        return copy(row);
      },
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const transactionOptions: { deadlineAtMs?: number }[] = [];
  const transaction = <T>(
    operation: (value: typeof tx) => Promise<T>,
    options?: { deadlineAtMs?: number }
  ): Promise<T> => {
    transactionOptions.push(options ?? {});
    const next = tail.then(() => operation(tx));
    tail = next.catch(() => undefined);
    return next;
  };
  const wire: temporal.api.workflowservice.v1.StartWorkflowExecutionRequest[] = [];
  const deadlines: (number | Date | undefined)[] = [];
  const deadline = new AsyncLocalStorage<number | Date>();
  let onStart: ((request: StartRequest, run: string) => Promise<void>) | undefined;
  const runs = new Map<string, { request: string; run: string; closed: boolean }>();
  let sequence = 0;
  const terminations: temporal.api.workflowservice.v1.ITerminateWorkflowExecutionRequest[] = [];
  const service = {
    async describeWorkflowExecution(
      request: temporal.api.workflowservice.v1.IDescribeWorkflowExecutionRequest
    ) {
      const execution = runs.get(request.execution!.workflowId!);
      if (!execution)
        throw Object.assign(new Error('Workflow not found'), {
          code: 5,
          details: 'Workflow not found',
          metadata: new Metadata(),
        });
      return temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse.fromObject({
        workflowExecutionInfo: {
          type: { name: 'AgentWorkflow' },
          taskQueue: SOURCE,
          historyLength: 1,
          startTime: { seconds: 1, nanos: 0 },
          execution: { workflowId: request.execution!.workflowId!, runId: execution.run },
          firstRunId: execution.run,
          status: execution.closed ? 2 : 1,
        },
      });
    },
    async terminateWorkflowExecution(
      request: temporal.api.workflowservice.v1.ITerminateWorkflowExecutionRequest
    ) {
      const execution = runs.get(request.workflowExecution!.workflowId!);
      assert(execution);
      assert.equal(request.firstExecutionRunId, execution.run);
      execution.closed = true;
      terminations.push(copy(request));
      return {};
    },
    async startWorkflowExecution(request: StartRequest) {
      const decoded = temporal.api.workflowservice.v1.StartWorkflowExecutionRequest.decode(
        temporal.api.workflowservice.v1.StartWorkflowExecutionRequest.encode(request).finish()
      );
      wire.push(decoded);
      deadlines.push(deadline.getStore());
      const previous = runs.get(decoded.workflowId);
      if (previous && (!previous.closed || decoded.workflowIdReusePolicy === 3)) {
        throw Object.assign(new Error('Already started'), {
          code: 6,
          details: 'Already started',
          metadata: new Metadata(),
        });
      }
      const run = `run-${++sequence}`;
      runs.set(decoded.workflowId, { request: decoded.requestId, run, closed: false });
      await onStart?.(decoded, run);
      return { runId: run };
    },
  };
  const connection = {
    workflowService: service,
    operatorService: {},
    plugins: [],
    ensureConnected: async () => undefined,
    close: async () => undefined,
    withDeadline: <T>(value: number | Date, operation: () => Promise<T>) =>
      deadline.run(value, operation),
    withMetadata: <T>(_value: unknown, operation: () => Promise<T>) => operation(),
    withAbortSignal: <T>(_value: unknown, operation: () => Promise<T>) => operation(),
  } as unknown as ConnectionLike;
  const client = new Client({
    connection,
    namespace: 'actual-sdk-test',
    dataConverter: {
      payloadCodecs: [
        {
          encode: async (payloads) =>
            payloads.map((payload) => ({
              ...payload,
              metadata: { ...payload.metadata, existingCodec: Buffer.from('preserved') },
            })),
          decode: async (payloads) => payloads,
        },
      ],
    },
    interceptors: {
      workflow: [
        {
          start: async (input, next) =>
            next({
              ...input,
              headers: {
                ...input.headers,
                existingInterceptor: { data: Buffer.from('preserved') },
              },
            }),
        },
      ],
    },
  });
  function agent(id: string) {
    agents.set(id, {
      id,
      temporalWorkflowId: id,
      temporalFirstExecutionRunId: null,
      deletedAt: null,
      createdAt: new Date('2026-10-16T00:01:00Z'),
      status: 'ACTIVE',
    });
  }
  const params = (id = 'root') => ({
    agentId: id,
    userId: 'user',
    goal: 'Original authored goal',
    model: 'rose-labs/rose-1-ultra',
    reasoningMaxTokens: 2048,
    verifier: { type: 'FLOAT_LLM_JUDGE' },
    taskQueue: SOURCE,
  });
  const start = (input: provider.StartAgentWorkflowParams = params(), end?: number) =>
    provider.startAgentWorkflowExecutionWithClient(client, input, end);
  return {
    agents,
    connection,
    tx,
    transaction,
    transactionOptions,
    client,
    terminations,
    effects,
    writes,
    wire,
    deadlines,
    runs,
    service,
    agent,
    params,
    start,
    onStart: (callback: typeof onStart) => {
      onStart = callback;
    },
  };
}

/** Mock persistence/native boundaries only; execute real lifecycle owners. */
export async function withFixtureDatabase<T>(
  f: ReturnType<typeof fixture>,
  operation: () => Promise<T>
): Promise<T> {
  const original = {
    transaction: prisma.$transaction,
    findUnique: prisma.agent.findUnique,
    findFirst: prisma.agent.findFirst,
    findMany: prisma.agent.findMany,
    update: prisma.agent.update,
    updateMany: prisma.agent.updateMany,
    queue: prisma.agentQueuePointer.findUnique,
    messages: prisma.message.findMany,
    effect: prisma.toolSideEffect.findFirst,
    effects: prisma.toolSideEffect.findMany,
  };
  try {
    prisma.$transaction = f.transaction as unknown as typeof prisma.$transaction;
    prisma.agent.findUnique = f.tx.agent.findUnique as unknown as typeof prisma.agent.findUnique;
    prisma.agent.findFirst = f.tx.agent.findUnique as unknown as typeof prisma.agent.findFirst;
    prisma.agent.update = f.tx.agent.update as unknown as typeof prisma.agent.update;
    prisma.agent.updateMany = f.tx.agent.updateMany as unknown as typeof prisma.agent.updateMany;
    prisma.agent.findMany = (async ({ where }: { where: { temporalWorkflowId?: unknown } }) =>
      where.temporalWorkflowId === null
        ? []
        : [...f.agents.values()]) as unknown as typeof prisma.agent.findMany;
    prisma.agentQueuePointer.findUnique = (async () => ({
      taskQueue: SOURCE,
    })) as unknown as typeof prisma.agentQueuePointer.findUnique;
    prisma.toolSideEffect.findMany = f.tx.toolSideEffect
      .findMany as unknown as typeof prisma.toolSideEffect.findMany;
    prisma.toolSideEffect.findFirst = f.tx.toolSideEffect
      .findFirst as unknown as typeof prisma.toolSideEffect.findFirst;
    prisma.message.findMany = (async () => []) as unknown as typeof prisma.message.findMany;
    return await operation();
  } finally {
    prisma.$transaction = original.transaction;
    prisma.agent.findUnique = original.findUnique;
    prisma.agent.findFirst = original.findFirst;
    prisma.agent.findMany = original.findMany;
    prisma.agent.update = original.update;
    prisma.agent.updateMany = original.updateMany;
    prisma.agentQueuePointer.findUnique = original.queue;
    prisma.toolSideEffect.findFirst = (async ({
      where,
    }: {
      where: { externalId: string; AND: { request: { path: string[]; equals: string } }[] };
    }) => {
      return (
        [...f.effects.values()].find(
          (row) =>
            row.status === 'STARTED' &&
            row.externalId === where.externalId &&
            where.AND.every((part) => row.request[part.request.path[0]] === part.request.equals)
        ) ?? null
      );
    }) as unknown as typeof prisma.toolSideEffect.findFirst;
    prisma.message.findMany = original.messages;
    prisma.toolSideEffect.findFirst = original.effect;
    prisma.toolSideEffect.findMany = original.effects;
  }
}
