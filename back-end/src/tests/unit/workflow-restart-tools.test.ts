#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Message } from '@prisma/client';
import { captureClaimedStaleWorkflowTools } from '../../domains/agents/agentRestartService';
import { prisma } from '../../providers/database';
import { finishAttentionMessages, resolveAndSignal } from '../../providers/gateResolution';
import { createMessage } from '../../providers/messages';
import {
  captureInProgressWorkflowTools,
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';
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
  await test('a claim-time generation race recaptures tools from the generation actually sealed', async () => {
    const oldSnapshot = [{ toolCallId: 'old-tool', metadata: {}, messageId: 'old-message' }];
    const claimedSnapshot = [
      { toolCallId: 'claimed-tool', metadata: {}, messageId: 'claimed-message' },
    ];
    let captures = 0;
    const recaptured = await captureClaimedStaleWorkflowTools(
      'agent-race',
      'candidate-a',
      'original',
      oldSnapshot,
      async (_agentId, workflowGeneration) => {
        captures += 1;
        assert.strictEqual(workflowGeneration, 'candidate-a');
        return claimedSnapshot;
      }
    );
    assert.deepStrictEqual(recaptured, claimedSnapshot);
    assert.strictEqual(captures, 1);

    const unchanged = await captureClaimedStaleWorkflowTools(
      'agent-race',
      'original',
      'original',
      oldSnapshot,
      async () => {
        throw new Error('same-generation snapshot must not be recaptured');
      }
    );
    assert.deepStrictEqual(unchanged, oldSnapshot);
  });

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

  await test('deployment interruption closes the stale approval request so retry creates a fresh gate', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const requestId = randomUUID();
      await prisma.agentAttentionRequest.create({
        data: {
          id: requestId,
          userId: `workflow-restart-unit-${agentId}`,
          agentId,
          workflowId: agentId,
          question: 'Approve the stale action?',
          gateKey: `stale-gate-${requestId}`,
        },
      });
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        requestUserApproval: { attentionRequestId: requestId },
      });

      await finalizeInterruptedWorkflowTools(agentId, agentId);
      await finalizeInterruptedWorkflowTools(agentId, agentId);

      const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const freshRequest = await prisma.agentAttentionRequest.create({
        data: {
          userId: `workflow-restart-unit-${agentId}`,
          agentId,
          workflowId: `${agentId}:replacement`,
          question: 'Retry the action on the replacement workflow?',
          gateKey: `stale-gate-${requestId}`,
        },
      });
      const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
      assert.strictEqual(request.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
      assert.strictEqual(terminals.length, 1);
      assert.strictEqual(metadataOf(terminals[0]).errorCode, 'DEPLOY_INTERRUPTED');
      assert.notStrictEqual(freshRequest.id, request.id);
      assert.strictEqual(freshRequest.userResponse, null);
      assert.strictEqual(freshRequest.workflowId, `${agentId}:replacement`);
      await prisma.agentAttentionRequest.deleteMany({
        where: { id: { in: [requestId, freshRequest.id] } },
      });
    });
  });

  await test('late approval cannot overwrite or signal after deployment terminalizes gate', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const requestId = randomUUID();
      const workflowId = agentId;
      await prisma.agentAttentionRequest.create({
        data: {
          id: requestId,
          userId: `workflow-restart-unit-${agentId}`,
          agentId,
          workflowId,
          question: 'Approve the stale action?',
        },
      });
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        attentionRequestId: requestId,
      });
      await finalizeInterruptedWorkflowTools(agentId, agentId);

      const result = await resolveAndSignal(
        { id: requestId, agentId, workflowId, metadata: null },
        'approved too late'
      );
      assert.deepStrictEqual(result, { resolved: false });
      const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      assert.strictEqual(request.userResponse, DEPLOY_INTERRUPTED_TOOL_MESSAGE);
    });
  });

  await test('a recorded user response is preserved when deployment wins the tool lifecycle race', async () => {
    await withAgent(async (agentId) => {
      const toolCallId = randomUUID();
      const requestId = randomUUID();
      await prisma.agentAttentionRequest.create({
        data: {
          id: requestId,
          userId: `workflow-restart-unit-${agentId}`,
          agentId,
          workflowId: agentId,
          question: 'Approve the racing action?',
          userResponse: 'approved just before cutover',
        },
      });
      await postTool(agentId, toolCallId, 'IN_PROGRESS', {
        toolName: 'request_user_approval',
        attentionRequestId: requestId,
      });

      await finalizeInterruptedWorkflowTools(agentId, agentId);

      const request = await prisma.agentAttentionRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const terminals = (await messagesForCall(agentId, toolCallId)).filter(isTerminal);
      assert.strictEqual(request.userResponse, 'approved just before cutover');
      assert.strictEqual(terminals.length, 1);
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
