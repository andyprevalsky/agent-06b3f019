import { defaultPayloadConverter, type Client } from '@temporalio/client';

interface FakeExecution {
  workflowId: string;
  firstExecutionRunId: string;
  args: unknown[];
  status: 'RUNNING' | 'TERMINATED';
  startTime: Date;
}

interface BlackboxTemporalEnv {
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
    let execution = executions.get(workflowId);
    if (execution === undefined) {
      execution = {
        workflowId,
        firstExecutionRunId: `blackbox-run-${nextRun++}`,
        args: [],
        status: 'RUNNING',
        startTime: new Date(),
      };
      executions.set(workflowId, execution);
    }
    return execution;
  };

  const getHandle = (workflowId: string) => {
    const execution = getExecution(workflowId);
    return {
      workflowId,
      firstExecutionRunId: execution.firstExecutionRunId,
      async describe() {
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
      async signal() {},
      async terminate() {
        execution.status = 'TERMINATED';
      },
    };
  };

  const client = {
    options: { namespace },
    async withDeadline<T>(_deadline: number | Date, operation: () => Promise<T>): Promise<T> {
      return operation();
    },
    workflow: {
      async start(_workflowType: string, options: { workflowId: string; args?: unknown[] }) {
        const execution = getExecution(options.workflowId);
        execution.args = options.args ?? [];
        execution.status = 'RUNNING';
        return getHandle(options.workflowId);
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

  return client as unknown as Client;
}
