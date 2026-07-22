#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Message } from '@prisma/client';
import { prisma } from '../../providers/database';
import { finishAttentionMessages } from '../../providers/gateResolution';
import { createMessage } from '../../providers/messages';
import {
  captureInProgressWorkflowTools,
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';
import { replaceStaleWorkflow, terminateWorkflowChain } from '../../providers/workflowReplacement';
import { claimWorkflowReplacement } from '../../providers/workflowReplacementState';
import { messageWorkflowGeneration } from '../../providers/workflowGeneration';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow restart tool reconciliation unit tests');

function metadataOf(message: Message): Record<string, unknown> {
  assert(message.metadata !== null && !Array.isArray(message.metadata));
  return message.metadata as Record<string, unknown>;
}

function isTerminal(message: Message): boolean {
  const status = metadataOf(message).toolStatus;
  return (
    typeof status === 'string' &&
    ['FINISHED', 'ERROR', 'SUCCESS', 'FAILED', 'COMPLETED'].includes(status.toUpperCase())
  );
}

async function createAgent(): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `workflow-restart-unit-${id}`,
      goal: 'test deployment tool reconciliation',
      status: 'ACTIVE',
      busId: id,
    },
  });
  return id;
}

async function postTool(
  agentId: string,
  toolCallId: string,
  toolStatus: string,
  extras: Record<string, unknown> = {},
  enforceCurrentWorkflowGeneration = false
): Promise<Message> {
  return createMessage({
    agentId,
    role: 'TOOL',
    text: `${toolStatus}:${toolCallId}`,
    metadata: {
      toolCallId,
      toolName: 'web_search',
      toolStatus,
      title: `Tool ${toolStatus}`,
      ...extras,
    },
    enforceCurrentWorkflowGeneration,
  });
}

async function messagesForCall(agentId: string, toolCallId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: {
      agentId,
      role: 'TOOL',
      metadata: { path: ['toolCallId'], equals: toolCallId },
    },
    orderBy: { timestamp: 'asc' },
  });
}

async function withAgent(fn: (agentId: string) => Promise<void>): Promise<void> {
  const agentId = await createAgent();
  try {
    await fn(agentId);
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function main(): Promise<void> {
  await test('a success committed before reconciliation prevents a deployment error', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      await postTool(agentId, toolCallId, 'IN_PROGRESS');
      const snapshot = await captureInProgressWorkflowTools(agentId);
      const success = await postTool(agentId, toolCallId, 'FINISHED');

      const result = await finalizeInterruptedWorkflowTools(agentId, agentId, snapshot);
      const lateProgress = await postTool(agentId, toolCallId, 'IN_PROGRESS', { stale: true });
      const messages = await messagesForCall(agentId, toolCallId);
      const terminals = messages.filter(isTerminal);

      assert.strictEqual(result.interrupted, 0);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(terminals[0].id, success.id);
      assert.strictEqual(lateProgress.id, success.id);
      assert.strictEqual(metadataOf(terminals[0]).toolStatus, 'FINISHED');
      assert.strictEqual(metadataOf(terminals[0]).deploymentFenced, true);
      assert(!messages.some((message) => message.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE));
    });
  });

  await test('a deployment error is terminal and suppresses late success and progress writes', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      await postTool(agentId, toolCallId, 'IN_PROGRESS');

      const result = await finalizeInterruptedWorkflowTools(agentId, agentId);
      const interrupted = (await messagesForCall(agentId, toolCallId)).find(
        (message) => message.text === DEPLOY_INTERRUPTED_TOOL_MESSAGE
      );
      assert(interrupted);

      const lateSuccess = await postTool(agentId, toolCallId, 'FINISHED');
      const lateProgress = await postTool(agentId, toolCallId, 'IN_PROGRESS', { progress: 99 });
      const messages = await messagesForCall(agentId, toolCallId);
      const terminals = messages.filter(isTerminal);

      assert.strictEqual(result.interrupted, 1);
      assert.strictEqual(lateSuccess.id, interrupted.id);
      assert.strictEqual(lateProgress.id, interrupted.id);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(metadataOf(terminals[0]).toolStatus, 'FINISHED');
      assert.strictEqual(metadataOf(terminals[0]).error, true);
      assert.strictEqual(metadataOf(terminals[0]).errorCode, 'DEPLOY_INTERRUPTED');
      assert.strictEqual(messages.filter((message) => !isTerminal(message)).length, 1);
    });
  });

  await test('concurrent success and deploy reconciliation produce exactly one terminal result', async () => {
    await withAgent(async (agentId) => {
      const toolCallIds = Array.from({ length: 24 }, () => randomUUID());
      await Promise.all(
        toolCallIds.map((toolCallId) => postTool(agentId, toolCallId, 'IN_PROGRESS'))
      );
      const snapshot = await captureInProgressWorkflowTools(agentId);

      await Promise.all([
        finalizeInterruptedWorkflowTools(agentId, agentId, snapshot),
        ...toolCallIds.map((toolCallId) => postTool(agentId, toolCallId, 'FINISHED')),
      ]);

      for (const toolCallId of toolCallIds) {
        const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
        assert.strictEqual(terminals.length, 1, `${toolCallId} must have exactly one terminal row`);
      }
    });
  });

  await test('reconciliation is idempotent, closes every unresolved call, and uses latest metadata', async () => {
    await withAgent(async (agentId) => {
      const firstCallId = randomUUID();
      const secondCallId = randomUUID();
      const alreadyFailedCallId = randomUUID();
      const legacySuccessCallId = randomUUID();

      await postTool(agentId, firstCallId, 'IN_PROGRESS', { revision: 1 });
      await postTool(agentId, firstCallId, 'IN_PROGRESS', { revision: 2, latestOnly: true });
      await postTool(agentId, secondCallId, 'IN_PROGRESS');
      await postTool(agentId, alreadyFailedCallId, 'IN_PROGRESS');
      await postTool(agentId, alreadyFailedCallId, 'ERROR');
      await postTool(agentId, legacySuccessCallId, 'IN_PROGRESS');
      await postTool(agentId, legacySuccessCallId, 'success');
      await createMessage({
        agentId,
        role: 'TOOL',
        text: 'progress without a call id',
        metadata: { toolName: 'web_search', toolStatus: 'IN_PROGRESS' },
      });

      await Promise.all(
        Array.from({ length: 4 }, () => finalizeInterruptedWorkflowTools(agentId, agentId))
      );
      const firstTerminal = (await messagesForCall(agentId, firstCallId)).filter(isTerminal);
      const secondTerminal = (await messagesForCall(agentId, secondCallId)).filter(isTerminal);
      const failedTerminal = (await messagesForCall(agentId, alreadyFailedCallId)).filter(
        isTerminal
      );
      const legacyTerminal = (await messagesForCall(agentId, legacySuccessCallId)).filter(
        isTerminal
      );

      assert.strictEqual(firstTerminal.length, 1);
      assert.strictEqual(secondTerminal.length, 1);
      assert.strictEqual(failedTerminal.length, 1);
      assert.strictEqual(legacyTerminal.length, 1);
      assert.strictEqual(metadataOf(firstTerminal[0]).latestOnly, true);
      assert.strictEqual(metadataOf(failedTerminal[0]).toolStatus, 'ERROR');
      assert.strictEqual(metadataOf(failedTerminal[0]).errorCode, undefined);
      assert.strictEqual(String(metadataOf(legacyTerminal[0]).toolStatus).toUpperCase(), 'SUCCESS');
      assert.strictEqual(
        await prisma.message.count({
          where: { agentId, text: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
        }),
        2
      );
    });
  });

  await test('approval resolution committed before reconciliation remains successful', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const request = {
        id: randomUUID(),
        agentId,
        workflowId: `stale-workflow-${agentId}`,
        metadata: null,
      };
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        attentionRequestId: request.id,
      });
      const snapshot = await captureInProgressWorkflowTools(agentId);
      await prisma.$transaction((tx) => finishAttentionMessages(tx, request));
      await finalizeInterruptedWorkflowTools(agentId, agentId, snapshot);

      const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(metadataOf(terminals[0]).toolStatus, 'FINISHED');
    });
  });

  await test('deployment interruption committed before approval prevents a contradictory success', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const request = {
        id: randomUUID(),
        agentId,
        workflowId: `stale-workflow-${agentId}`,
        metadata: null,
      };
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        attentionRequestId: request.id,
      });
      const snapshot = await captureInProgressWorkflowTools(agentId);
      await finalizeInterruptedWorkflowTools(agentId, agentId, snapshot);
      await prisma.$transaction((tx) => finishAttentionMessages(tx, request));

      const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(metadataOf(terminals[0]).toolStatus, 'FINISHED');
      assert.strictEqual(metadataOf(terminals[0]).errorCode, 'DEPLOY_INTERRUPTED');
    });
  });

  await test('concurrent approval and deployment reconciliation still choose one terminal result', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const request = {
        id: randomUUID(),
        agentId,
        workflowId: `stale-workflow-${agentId}`,
        metadata: null,
      };
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        attentionRequestId: request.id,
      });
      const snapshot = await captureInProgressWorkflowTools(agentId);
      await Promise.all([
        finalizeInterruptedWorkflowTools(agentId, agentId, snapshot),
        prisma.$transaction((tx) => finishAttentionMessages(tx, request)),
      ]);

      const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
      assert.strictEqual(terminals.length, 1);
    });
  });

  await test('a brand-new stale call arriving after finalization is immediately terminalized', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
      });
      const claim = await claimWorkflowReplacement(agentId);
      await finalizeInterruptedWorkflowTools(agentId, agentId);

      const lateCallId = randomUUID();
      const lateProgress = await postTool(
        agentId,
        lateCallId,
        'IN_PROGRESS',
        { workflowGeneration: agentId },
        true
      );
      const lateSuccess = await postTool(
        agentId,
        lateCallId,
        'FINISHED',
        { workflowGeneration: agentId },
        true
      );
      const rows = await messagesForCall(agentId, lateCallId);

      assert.strictEqual(lateProgress.id, lateSuccess.id);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].text, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
      assert.strictEqual(metadataOf(rows[0]).toolStatus, 'FINISHED');
      assert.strictEqual(messageWorkflowGeneration(rows[0]), agentId);
      assert.notStrictEqual(claim.plannedWorkflowId, agentId);
    });
  });

  await test('the same tool call ID remains independent in the replacement generation', async () => {
    await withAgent(async (agentId) => {
      await prisma.agent.update({
        where: { id: agentId },
        data: { temporalWorkflowId: agentId },
      });
      const toolCallId = 'tc-agent-init';
      await postTool(agentId, toolCallId, 'IN_PROGRESS', { workflowGeneration: agentId }, true);
      const claim = await claimWorkflowReplacement(agentId);
      await finalizeInterruptedWorkflowTools(agentId, agentId);

      const freshProgress = await postTool(
        agentId,
        toolCallId,
        'IN_PROGRESS',
        { workflowGeneration: claim.plannedWorkflowId },
        true
      );
      const freshSuccess = await postTool(
        agentId,
        toolCallId,
        'FINISHED',
        { workflowGeneration: claim.plannedWorkflowId },
        true
      );
      const staleLateSuccess = await postTool(
        agentId,
        toolCallId,
        'FINISHED',
        { workflowGeneration: agentId },
        true
      );
      const rows = await messagesForCall(agentId, toolCallId);
      const oldRows = rows.filter((row) => messageWorkflowGeneration(row) === agentId);
      const freshRows = rows.filter(
        (row) => messageWorkflowGeneration(row) === claim.plannedWorkflowId
      );

      assert.notStrictEqual(freshProgress.id, staleLateSuccess.id);
      assert.strictEqual(metadataOf(freshSuccess).toolStatus, 'FINISHED');
      assert.strictEqual(oldRows.filter(isTerminal).length, 1);
      assert.strictEqual(freshRows.filter(isTerminal).length, 1);
    });
  });

  await test('latest lifecycle state wins when a tool call is reopened', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const first = await postTool(agentId, toolCallId, 'IN_PROGRESS');
      const failed = await postTool(agentId, toolCallId, 'ERROR');
      const reopened = await postTool(agentId, toolCallId, 'IN_PROGRESS', { retry: 2 });
      // Worker-supplied display timestamps are not a safe lifecycle sequence.
      // Invert them to prove reconciliation follows durable DB creation order.
      const displayBase = Date.now() + 60_000;
      await prisma.message.update({
        where: { id: first.id },
        data: { timestamp: new Date(displayBase + 2_000) },
      });
      await prisma.message.update({
        where: { id: failed.id },
        data: { timestamp: new Date(displayBase + 1_000) },
      });
      await prisma.message.update({
        where: { id: reopened.id },
        data: { timestamp: new Date(displayBase) },
      });

      const snapshot = await captureInProgressWorkflowTools(agentId, agentId);
      assert.strictEqual(snapshot.length, 1);
      await finalizeInterruptedWorkflowTools(agentId, agentId, snapshot);

      const rows = await messagesForCall(agentId, toolCallId);
      const deploymentErrors = rows.filter(
        (row) => metadataOf(row).errorCode === 'DEPLOY_INTERRUPTED'
      );
      assert.strictEqual(deploymentErrors.length, 1);
    });
  });

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
