import {
  defaultPayloadConverter,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
  type Client,
  type WorkflowIdConflictPolicy,
  type WorkflowIdReusePolicy,
} from '@temporalio/client';

export interface BlackboxTemporalSignal {
  name: string;
  args: unknown[];
}

interface FakeExecution {
  workflowId: string;
  firstExecutionRunId: string;
  args: unknown[];
  status: 'RUNNING' | 'TERMINATED';
  startTime: Date;
  signals: BlackboxTemporalSignal[];
}

const executionsByClient = new WeakMap<object, Map<string, FakeExecution>>();

/** Signals delivered to a fake workflow, in delivery order. */
export function blackboxTemporalSignals(
  client: Client,
  workflowId: string
): readonly BlackboxTemporalSignal[] {
  const executions = executionsByClient.get(client);
  if (executions === undefined) {
    throw new Error('blackboxTemporalSignals requires the in-memory blackbox Temporal client');
  }
  return executions.get(workflowId)?.signals ?? [];
}

interface BlackboxTemporalEnv {
  [key: string]: string | undefined;
  BLACKBOX_TEST_CAPTURE_OUTBOUND?: string;
  BLACKBOX_TEST_FAKE_TEMPORAL?: string;
  NODE_ENV?: string;
  TEMPORAL_NAMESPACE?: string;
}

export function shouldUseBlackboxTemporalFake(env: BlackboxTemporalEnv = process.env): boolean {
  if (env.BLACKBOX_TEST_FAKE_TEMPORAL !== '1') return false;
  if (env.NODE_ENV === 'production' || env.BLACKBOX_TEST_CAPTURE_OUTBOUND !== '1') {
    throw new Error('BLACKBOX_TEST_FAKE_TEMPORAL requires non-production outbound capture mode');
  }
  return true;
}

/**
 * Minimal in-memory Temporal client for local blackbox route contracts.
 * Durable workflow behavior remains covered by the provider's unit tests and
 * production smoke probes; this fake only keeps deterministic local HTTP tests
 * from depending on Temporal Cloud network access.
 */
export function createBlackboxTemporalClient(namespace = 'blackbox'): Client {
  const executions = new Map<string, FakeExecution>();
  let nextRun = 1;

  const getExecution = (workflowId: string): FakeExecution => {
    const execution = executions.get(workflowId);
    if (execution !== undefined) return execution;
    throw new WorkflowNotFoundError(
      `Workflow execution ${workflowId} was not found`,
      workflowId,
      undefined
    );
  };

  const getHandle = (workflowId: string, firstExecutionRunId?: string) => {
    return {
      workflowId,
      firstExecutionRunId,
      async describe() {
        const execution = getExecution(workflowId);
        return {
          status: { name: execution.status },
          runId: execution.firstExecutionRunId,
          startTime: execution.startTime,
          raw: {
            workflowExecutionInfo: {
              firstRunId: execution.firstExecutionRunId,
            },
          },
        };
      },
      async signal(name: string, ...args: unknown[]) {
        getExecution(workflowId).signals.push({ name, args });
      },
      async terminate() {
        const execution = getExecution(workflowId);
        if (
          firstExecutionRunId !== undefined &&
          execution.firstExecutionRunId !== firstExecutionRunId
        ) {
          throw new WorkflowNotFoundError(
            `Workflow execution ${workflowId}/${firstExecutionRunId} was not found`,
            workflowId,
            firstExecutionRunId
          );
        }
        execution.status = 'TERMINATED';
      },
    };
  };

  type FakeStartOptions = {
    workflowId: string;
    args?: unknown[];
    workflowIdConflictPolicy?: WorkflowIdConflictPolicy;
    workflowIdReusePolicy?: WorkflowIdReusePolicy;
  };

  const alreadyStarted = (workflowId: string, workflowType: string): never => {
    throw new WorkflowExecutionAlreadyStartedError(
      `Workflow execution ${workflowId} already exists`,
      workflowId,
      workflowType
    );
  };

  const client = {
    options: { namespace },
    async withDeadline<T>(_deadline: number | Date, operation: () => Promise<T>): Promise<T> {
      return operation();
    },
    workflow: {
      async start(workflowType: string, options: FakeStartOptions) {
        const existing = executions.get(options.workflowId);
        if (existing?.status === 'RUNNING') {
          if (options.workflowIdConflictPolicy === 'USE_EXISTING') {
            return getHandle(existing.workflowId, existing.firstExecutionRunId);
          }
          const terminateExisting =
            options.workflowIdConflictPolicy === 'TERMINATE_EXISTING' ||
            (options.workflowIdConflictPolicy === undefined &&
              options.workflowIdReusePolicy === 'TERMINATE_IF_RUNNING');
          if (!terminateExisting) alreadyStarted(options.workflowId, workflowType);
          existing.status = 'TERMINATED';
        } else if (existing !== undefined && options.workflowIdReusePolicy === 'REJECT_DUPLICATE') {
          alreadyStarted(options.workflowId, workflowType);
        }

        const execution: FakeExecution = {
          workflowId: options.workflowId,
          firstExecutionRunId: `blackbox-run-${nextRun++}`,
          args: options.args ?? [],
          status: 'RUNNING',
          startTime: new Date(),
          signals: [],
        };
        executions.set(options.workflowId, execution);
        return getHandle(options.workflowId, execution.firstExecutionRunId);
      },
      getHandle,
      async *list() {
        for (const execution of executions.values()) {
          yield {
            workflowId: execution.workflowId,
            runId: execution.firstExecutionRunId,
          };
        }
      },
    },
    workflowService: {
      async getWorkflowExecutionHistory(request: { execution: { workflowId: string } }) {
        const execution = getExecution(request.execution.workflowId);
        return {
          history: {
            events: [
              {
                workflowExecutionStartedEventAttributes: {
                  input: {
                    payloads: execution.args.map((arg) => defaultPayloadConverter.toPayload(arg)),
                  },
                },
              },
            ],
          },
        };
      },
    },
  };

  executionsByClient.set(client, executions);
  return client as unknown as Client;
}
