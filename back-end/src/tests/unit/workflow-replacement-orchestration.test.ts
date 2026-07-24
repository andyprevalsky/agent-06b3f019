#!/usr/bin/env tsx

import assert from 'node:assert';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { prisma } from '../../providers/database';
import {
  replaceStaleWorkflow,
  terminateWorkflowChain,
  terminateWorkflowChainWithDeadline,
} from '../../providers/workflowReplacement';
import {
  claimTemporalWorkflowIdForTerminationWithClient,
  DESCENDANT_START_TOMBSTONE_TASK_QUEUE,
  resolveTemporalWorkflowExecutionRefWithClient,
  startAgentWorkflowExecutionWithClient,
  TEMPORAL_CONTROL_RPC_TIMEOUT_MS,
} from '../../providers/temporal';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness(
  'workflow replacement Temporal orchestration unit tests'
);

async function main(): Promise<void> {
  await test('termination is bound to the stale Temporal execution chain', async () => {
    const calls: unknown[][] = [];
    let terminationReason = '';
    await terminateWorkflowChain(
      {
        getHandle: (...args) => {
          calls.push(args);
          return {
            terminate: async (reason) => {
              terminationReason = reason;
            },
          };
        },
      },
      { workflowId: 'workflow-1', firstExecutionRunId: 'first-run-1' }
    );

    assert.deepStrictEqual(calls, [
      ['workflow-1', undefined, { firstExecutionRunId: 'first-run-1' }],
    ]);
    assert.strictEqual(terminationReason, 'Restarting with new worker code');
  });

  await test('replacement describe, start, and terminate deadlines propagate timeout failures', async () => {
    const timeout = new Error('synthetic Temporal control deadline exceeded');
    const deadlines: number[] = [];
    let operationsInvoked = 0;
    const deadlineClient = {
      withDeadline: async (deadline: number, _operation: () => Promise<unknown>) => {
        deadlines.push(deadline);
        throw timeout;
      },
      workflow: {
        getHandle: () => ({
          describe: async () => {
            operationsInvoked += 1;
            return {};
          },
          terminate: async () => {
            operationsInvoked += 1;
          },
        }),
        start: async () => {
          operationsInvoked += 1;
          return {};
        },
      },
    };
    const startedAt = Date.now();

    await assert.rejects(
      resolveTemporalWorkflowExecutionRefWithClient(deadlineClient as never, 'workflow-1'),
      /synthetic Temporal control deadline exceeded/
    );
    await assert.rejects(
      startAgentWorkflowExecutionWithClient(deadlineClient as never, {
        agentId: 'agent-1',
        userId: 'user-1',
        goal: 'bounded replacement start',
        model: 'rose-labs/rose-1-ultra',
        reasoningMaxTokens: 2048,
        verifier: { type: 'FLOAT_LLM_JUDGE' },
        taskQueue: 'replacement-test-queue',
      }),
      /synthetic Temporal control deadline exceeded/
    );
    await assert.rejects(
      terminateWorkflowChainWithDeadline(deadlineClient as never, {
        workflowId: 'workflow-1',
        firstExecutionRunId: 'run-1',
      }),
      /synthetic Temporal control deadline exceeded/
    );

    assert.strictEqual(deadlines.length, 3);
    assert.strictEqual(operationsInvoked, 0);
    for (const deadline of deadlines) {
      assert(deadline >= startedAt + TEMPORAL_CONTROL_RPC_TIMEOUT_MS);
      assert(deadline <= Date.now() + TEMPORAL_CONTROL_RPC_TIMEOUT_MS);
    }
  });

  await test('ambiguous descendant start claims one exact tombstone-or-agent chain', async () => {
    const workflowId = 'ambiguous-child-1';
    let capturedOptions: Record<string, unknown> | undefined;
    const tombstoneClient = {
      withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
      workflow: {
        start: async (_workflowType: string, options: Record<string, unknown>) => {
          capturedOptions = options;
          return { workflowId, firstExecutionRunId: 'tombstone-first-run' };
        },
      },
    };
    assert.deepStrictEqual(
      await claimTemporalWorkflowIdForTerminationWithClient(tombstoneClient as never, workflowId),
      { workflowId, firstExecutionRunId: 'tombstone-first-run' }
    );
    assert.strictEqual(capturedOptions?.taskQueue, DESCENDANT_START_TOMBSTONE_TASK_QUEUE);
    assert.strictEqual(capturedOptions?.workflowIdReusePolicy, 'REJECT_DUPLICATE');
    assert.strictEqual(capturedOptions?.workflowIdConflictPolicy, 'FAIL');

    const originalClient = {
      withDeadline: async (_deadline: number, operation: () => Promise<unknown>) => operation(),
      workflow: {
        start: async () => {
          throw new WorkflowExecutionAlreadyStartedError(
            'already started',
            workflowId,
            'AgentWorkflow'
          );
        },
        getHandle: () => ({
          describe: async () => ({
            raw: { workflowExecutionInfo: { firstRunId: 'agent-first-run' } },
          }),
        }),
      },
    };
    assert.deepStrictEqual(
      await claimTemporalWorkflowIdForTerminationWithClient(originalClient as never, workflowId),
      { workflowId, firstExecutionRunId: 'agent-first-run' }
    );
  });

  await test('workflow replacement terminates, reconciles, then starts in strict order', async () => {
    const events: string[] = [];
    const workflowId = await replaceStaleWorkflow(
      {
        agentId: 'agent-1',
        staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
        staleWorkflowGeneration: 'workflow-1',
      },
      {
        captureInProgressTools: async () => {
          events.push('capture');
          return [
            {
              toolCallId: 'tool-1',
              workflowGeneration: 'workflow-1',
              metadata: { toolCallId: 'tool-1' },
            },
          ];
        },
        terminate: async () => {
          events.push('terminate');
        },
        finalizeInterruptedTools: async (_agentId, _generation, snapshot) => {
          events.push('finalize');
          assert.strictEqual(snapshot[0]?.toolCallId, 'tool-1');
          return { candidates: 1, interrupted: 1 };
        },
        startFresh: async () => {
          events.push('start');
          return { workflowId: 'workflow-2', firstExecutionRunId: 'run-2' };
        },
      }
    );

    assert.strictEqual(workflowId.workflowId, 'workflow-2');
    assert.deepStrictEqual(events, ['capture', 'terminate', 'finalize', 'start']);
  });

  await test('a root snapshot captured before its claim is reused without a racy recapture', async () => {
    const events: string[] = [];
    const preTerminationSnapshot = [
      {
        toolCallId: 'tool-before-claim',
        workflowGeneration: 'workflow-1',
        metadata: { toolCallId: 'tool-before-claim' },
      },
    ];
    await replaceStaleWorkflow(
      {
        agentId: 'agent-1',
        staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
        staleWorkflowGeneration: 'workflow-1',
        preTerminationSnapshot,
      },
      {
        captureInProgressTools: async () => {
          throw new Error('root tools must not be recaptured after the generation seal');
        },
        terminate: async () => {
          events.push('terminate');
        },
        finalizeInterruptedTools: async (_agentId, _generation, snapshot) => {
          events.push('finalize');
          assert.deepStrictEqual(snapshot, preTerminationSnapshot);
          return { candidates: 1, interrupted: 1 };
        },
        startFresh: async () => {
          events.push('start');
          return { workflowId: 'workflow-2', firstExecutionRunId: 'run-2' };
        },
      }
    );
    assert.deepStrictEqual(events, ['terminate', 'finalize', 'start']);
  });

  await test('replacement never reconciles or starts when termination fails', async () => {
    const events: string[] = [];
    await assert.rejects(
      replaceStaleWorkflow(
        {
          agentId: 'agent-1',
          staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
          staleWorkflowGeneration: 'workflow-1',
        },
        {
          captureInProgressTools: async () => {
            events.push('capture');
            return [];
          },
          terminate: async () => {
            events.push('terminate');
            throw new Error('termination failed');
          },
          finalizeInterruptedTools: async () => {
            events.push('finalize');
            return { candidates: 0, interrupted: 0 };
          },
          startFresh: async () => {
            events.push('start');
            return { workflowId: 'workflow-2', firstExecutionRunId: 'run-2' };
          },
        }
      ),
      /termination failed/
    );
    assert.deepStrictEqual(events, ['capture', 'terminate']);
  });

  await test('replacement never terminates when the pre-stop snapshot fails', async () => {
    const events: string[] = [];
    await assert.rejects(
      replaceStaleWorkflow(
        {
          agentId: 'agent-1',
          staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
          staleWorkflowGeneration: 'workflow-1',
        },
        {
          captureInProgressTools: async () => {
            events.push('capture');
            throw new Error('snapshot failed');
          },
          terminate: async () => {
            events.push('terminate');
          },
          finalizeInterruptedTools: async () => {
            events.push('finalize');
            return { candidates: 0, interrupted: 0 };
          },
          startFresh: async () => {
            events.push('start');
            return { workflowId: 'workflow-2', firstExecutionRunId: 'run-2' };
          },
        }
      ),
      /snapshot failed/
    );
    assert.deepStrictEqual(events, ['capture']);
  });

  await test('replacement never starts when tool reconciliation fails', async () => {
    const events: string[] = [];
    await assert.rejects(
      replaceStaleWorkflow(
        {
          agentId: 'agent-1',
          staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
          staleWorkflowGeneration: 'workflow-1',
        },
        {
          captureInProgressTools: async () => {
            events.push('capture');
            return [];
          },
          terminate: async () => {
            events.push('terminate');
          },
          finalizeInterruptedTools: async () => {
            events.push('finalize');
            throw new Error('reconciliation failed');
          },
          startFresh: async () => {
            events.push('start');
            return { workflowId: 'workflow-2', firstExecutionRunId: 'run-2' };
          },
        }
      ),
      /reconciliation failed/
    );
    assert.deepStrictEqual(events, ['capture', 'terminate', 'finalize']);
  });

  await test('a fresh-start failure occurs only after the stale workflow is safely reconciled', async () => {
    const events: string[] = [];
    await assert.rejects(
      replaceStaleWorkflow(
        {
          agentId: 'agent-1',
          staleExecution: { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' },
          staleWorkflowGeneration: 'workflow-1',
        },
        {
          captureInProgressTools: async () => {
            events.push('capture');
            return [];
          },
          terminate: async () => {
            events.push('terminate');
          },
          finalizeInterruptedTools: async () => {
            events.push('finalize');
            return { candidates: 0, interrupted: 0 };
          },
          startFresh: async () => {
            events.push('start');
            throw new Error('start failed');
          },
        }
      ),
      /start failed/
    );
    assert.deepStrictEqual(events, ['capture', 'terminate', 'finalize', 'start']);
  });

  await test('starting without a stale workflow does not invent deployment errors', async () => {
    const events: string[] = [];
    await replaceStaleWorkflow(
      { agentId: 'agent-1', staleExecution: null, staleWorkflowGeneration: null },
      {
        captureInProgressTools: async () => {
          events.push('capture');
          return [];
        },
        terminate: async () => {
          events.push('terminate');
        },
        finalizeInterruptedTools: async () => {
          events.push('finalize');
          return { candidates: 0, interrupted: 0 };
        },
        startFresh: async () => {
          events.push('start');
          return { workflowId: 'workflow-1', firstExecutionRunId: 'run-1' };
        },
      }
    );
    assert.deepStrictEqual(events, ['start']);
  });

  finish();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exit(1);
});
