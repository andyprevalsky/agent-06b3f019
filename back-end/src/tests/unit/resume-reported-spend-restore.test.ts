#!/usr/bin/env tsx
/**
 * A resume run's total (the ledger, resumeReportedSpend.ts) survives its owner's
 * deployment replacement: the restore rebuilds the in-memory cost WITHOUT resume
 * spend and the next write adds the ledger back, so it is neither lost nor doubled.
 */
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { claimWorkflowReplacement } from '../../providers/workflowReplacementState';
import { applyResumeCost } from '../../domains/agents/agentResumeCostService';
import { resumeLedgerNamespace, resumeSpendOf } from '../../providers/resumeReportedSpend';
import { updateAgentConfig } from '../../domains/agents/agentConfigService';
import { deleteEphemeral } from '../../providers/sharedState';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('resume reported spend restore unit tests');

async function main(): Promise<void> {
  await test('the restore adds back the resume spend the running workflow held', async () => {
    const agentId = randomUUID();
    const key = `resume:code-resume:${agentId}:m-row`;
    await prisma.agent.create({
      data: {
        id: agentId,
        userId: `resume-reported-unit-${agentId}`,
        goal: 'owner holding a resume run spend',
        status: 'ACTIVE',
        busId: agentId,
        temporalWorkflowId: agentId,
        ownCostCents: 10,
        treeCostCents: 10,
      },
    });
    try {
      const answer = await applyResumeCost(agentId, { key, total_cents: 6 });
      assert.ok(!('error' in answer), JSON.stringify(answer));
      assert.strictEqual(await resumeSpendOf(agentId), 6);
      const row = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.strictEqual(row.treeCostCents, 16, 'the tree grows by the total');
      assert.strictEqual(row.ownCostCents, 10, 'own cost untouched');
      // The restored in-memory view excludes resume spend (no workflow ever holds it)…
      const claim = await claimWorkflowReplacement(agentId);
      assert.strictEqual(claim.resumeState.subtree_cost_cents, 10);
      assert.ok(
        !Object.keys(claim.resumeState.children_cost_cents).some((k) => k.startsWith('resume:'))
      );
      // …and its next write stores own + resume spend, counted once.
      const written = await updateAgentConfig(
        agentId,
        { tree_cost_cents: claim.resumeState.subtree_cost_cents, own_cost_cents: 10 },
        undefined,
        undefined,
        { broadcastUpdate: async () => {} }
      );
      assert.strictEqual(
        (written as { agent: { tree_cost_cents: number } }).agent.tree_cost_cents,
        16
      );
    } finally {
      await deleteEphemeral(resumeLedgerNamespace(agentId), key);
      await deleteEphemeral('resume-total', agentId);
      await prisma.agent.deleteMany({ where: { id: agentId } });
    }
  });

  finish();
}

void main();
