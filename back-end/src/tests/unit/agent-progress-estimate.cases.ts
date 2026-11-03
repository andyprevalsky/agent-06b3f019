import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { updateProgressEstimate } from '../../domains/agents/repoProgressEstimate';
import { hydrateProgressEstimates } from '../../providers/agentProgressEstimates';
import { prisma } from '../../providers/database';
import type { ProgressEstimate } from '../../utils/progressEstimate';

async function createAgent() {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `jev-test-${id}`,
      goal: 'JEV fencing',
      temporalWorkflowId: id,
      status: 'ACTIVE',
      progress: 0.2,
    },
  });
  return id;
}

export async function testJevProgressEstimates() {
  const agentId = await createAgent();
  const estimate: ProgressEstimate = {
    progress: 0.25,
    etaSeconds: 120,
    observedAt: '2026-10-21T12:00:00.000Z',
    sequence: 1,
    model: 'jev-1.13.0',
    promptVersion: 'test-v1',
  };
  try {
    assert.strictEqual(
      (await updateProgressEstimate(agentId, agentId, estimate)).outcome,
      'updated'
    );
    assert.strictEqual(
      (await updateProgressEstimate(agentId, agentId, estimate)).outcome,
      'unchanged'
    );
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          sequence: 2,
          observedAt: '2026-10-21T11:59:59.000Z',
        })
      ).outcome,
      'unchanged'
    );
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, 'obsolete', {
          ...estimate,
          sequence: 3,
        })
      ).outcome,
      'stale_generation'
    );
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          taskId: 'unknown',
        })
      ).outcome,
      'unknown_task'
    );
    const taskId = 'browser-task';
    await prisma.message.create({
      data: {
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL',
        text: 'started',
        metadata: {
          task_id: taskId,
          action_type: 'goto',
          toolStatus: 'FINISHED',
          subAgentId: taskId,
        },
      },
    });
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          taskId,
          progress: 0.7,
        })
      ).outcome,
      'updated',
      'finished sub-step must not end task'
    );
    let row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    let hydrated = (await hydrateProgressEstimates([row]))[0];
    assert.deepStrictEqual(hydrated.progressEstimate, estimate);
    assert.strictEqual(hydrated.taskProgressEstimates[taskId].progress, 0.7);
    assert.strictEqual(row.progress, 0.2, 'JEV must not overwrite legacy progress');
    await prisma.message.create({
      data: {
        agentId,
        workflowGeneration: agentId,
        role: 'TOOL',
        text: 'finished',
        metadata: { task_id: taskId, action_type: 'task_complete', toolStatus: 'FINISHED' },
      },
    });
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          taskId,
          sequence: 4,
        })
      ).outcome,
      'terminal'
    );
    await prisma.agent.update({ where: { id: agentId }, data: { status: 'FAILED' } });
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          sequence: 5,
        })
      ).outcome,
      'terminal'
    );
    const nextGeneration = `${agentId}:next`;
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        status: 'ACTIVE',
        temporalWorkflowId: nextGeneration,
      },
    });
    row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    hydrated = (await hydrateProgressEstimates([row]))[0];
    assert.strictEqual(hydrated.progressEstimate, null);
    assert.deepStrictEqual(hydrated.taskProgressEstimates, {});
    assert.strictEqual(
      (await updateProgressEstimate(agentId, nextGeneration, estimate)).outcome,
      'updated'
    );
    await Promise.all(
      [2, 4, 3].map((sequence) =>
        updateProgressEstimate(agentId, nextGeneration, {
          ...estimate,
          sequence,
        })
      )
    );
    row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert.strictEqual((row.progressEstimate as unknown as ProgressEstimate).sequence, 4);
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, agentId, {
          ...estimate,
          taskId,
          sequence: 99,
        })
      ).outcome,
      'stale_generation'
    );
    assert.strictEqual(
      (
        await updateProgressEstimate(agentId, nextGeneration, {
          ...estimate,
          taskId,
        })
      ).outcome,
      'unknown_task',
      'old-generation identity must not authorize a new task'
    );
    for (const status of ['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'] as const) {
      await prisma.agent.update({ where: { id: agentId }, data: { status } });
      assert.strictEqual(
        (
          await updateProgressEstimate(agentId, nextGeneration, {
            ...estimate,
            sequence: 99,
          })
        ).outcome,
        'terminal'
      );
    }
  } finally {
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}
