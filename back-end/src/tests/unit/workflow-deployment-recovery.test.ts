#!/usr/bin/env tsx

import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  runWorkflowDeploymentCutover,
  type WorkflowDeploymentCandidate,
} from '../../providers/workflowDeploymentMigration';
import {
  completeWorkflowDeploymentManifest,
  loadOrCreateWorkflowDeploymentManifest,
} from '../../providers/workflowDeploymentManifest';
import { createTestHarness } from './trace-archive-test-utils';

const { test, finish } = createTestHarness('workflow deployment recovery unit tests');

async function main(): Promise<void> {
  await test('forward-only retry skips a migrated canary and converges existing claims', async () => {
    const candidates = Array.from({ length: 3 }, (_, index) => ({
      agentId: `retry-agent-${index}`,
      workflowId: `retry-workflow-${index}`,
    }));
    const currentWorkflowIds = new Map(
      candidates.map((candidate) => [candidate.agentId, candidate.workflowId])
    );
    const staleWorkflowIds = new Map<string, string>();
    const claims = new Map<string, string>();
    const starts = new Map<string, number>();
    let failSecondCanary = true;
    const dependencies = {
      preflight: async (candidate: WorkflowDeploymentCandidate) => {
        if (
          currentWorkflowIds.get(candidate.agentId) !== candidate.workflowId &&
          staleWorkflowIds.get(candidate.agentId) !== candidate.workflowId
        ) {
          return { outcome: 'skipped' as const };
        }
        return { outcome: 'ready' as const };
      },
      prepare: async (candidate: WorkflowDeploymentCandidate) => {
        const claim = claims.get(candidate.agentId) ?? `claim-${candidate.agentId}`;
        claims.set(candidate.agentId, claim);
        staleWorkflowIds.set(candidate.agentId, candidate.workflowId);
        return { outcome: 'prepared' as const, prepared: claim };
      },
      activate: async () => undefined,
      start: async (candidate: WorkflowDeploymentCandidate) => {
        starts.set(candidate.agentId, (starts.get(candidate.agentId) ?? 0) + 1);
        const workflowId = `new-${candidate.agentId}`;
        currentWorkflowIds.set(candidate.agentId, workflowId);
        return { workflowId };
      },
      waitUntilReady: async (candidate: WorkflowDeploymentCandidate) => {
        if (candidate.agentId === 'retry-agent-1' && failSecondCanary) {
          throw new Error('synthetic canary bootstrap failure');
        }
        staleWorkflowIds.delete(candidate.agentId);
      },
    };

    const first = await runWorkflowDeploymentCutover(candidates, dependencies, {
      concurrency: 3,
      canaryCount: 2,
    });
    assert.strictEqual(first.haltedAfter, 'canary');
    assert.strictEqual(starts.get('retry-agent-0'), 1);
    assert.strictEqual(starts.get('retry-agent-1'), 1);
    assert.strictEqual(starts.get('retry-agent-2'), undefined);
    const originalClaims = new Map(claims);

    failSecondCanary = false;
    const second = await runWorkflowDeploymentCutover(candidates, dependencies, {
      concurrency: 3,
      canaryCount: 2,
    });
    assert.strictEqual(second.haltedAfter, null);
    assert.strictEqual(starts.get('retry-agent-0'), 1);
    assert.strictEqual(starts.get('retry-agent-1'), 2);
    assert.strictEqual(starts.get('retry-agent-2'), 1);
    assert.deepStrictEqual(claims, originalClaims);
    assert(second.outcomes.every((outcome) => ['migrated', 'skipped'].includes(outcome.outcome)));
  });

  await test('10k-candidate preflight is bounded and completes before the first mutation', async () => {
    const candidates = Array.from({ length: 10_000 }, (_, index) => ({
      agentId: `scale-agent-${index}`,
      workflowId: `scale-workflow-${index}`,
    }));
    const concurrency = 32;
    let activePreflights = 0;
    let maxActivePreflights = 0;
    let completedPreflights = 0;
    let prepared = 0;
    const result = await runWorkflowDeploymentCutover(
      candidates,
      {
        preflight: async () => {
          activePreflights += 1;
          maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
          await Promise.resolve();
          activePreflights -= 1;
          completedPreflights += 1;
          return { outcome: 'ready' };
        },
        prepare: async (candidate) => {
          assert.strictEqual(completedPreflights, candidates.length);
          prepared += 1;
          return { outcome: 'prepared', prepared: candidate.agentId };
        },
        activate: async () => undefined,
        start: async (candidate) => ({ workflowId: `new-${candidate.agentId}` }),
        waitUntilReady: async () => undefined,
      },
      { concurrency, canaryCount: 4 }
    );
    assert.strictEqual(maxActivePreflights, concurrency);
    assert.strictEqual(completedPreflights, candidates.length);
    assert.strictEqual(prepared, candidates.length);
    assert.strictEqual(result.haltedAfter, null);
  });

  await test('exact deployment manifest is immutable and reused without resnapshotting', async () => {
    const buildId = 'b'.repeat(40);
    const deploymentToken = `manifest-${randomUUID()}`;
    const snapshotAt = new Date();
    const originalCandidates = [
      { agentId: 'manifest-agent-1', workflowId: 'manifest-workflow-1', status: 'ACTIVE' as const },
    ];
    const first = await loadOrCreateWorkflowDeploymentManifest(
      buildId,
      deploymentToken,
      async () => ({ snapshotAt, candidates: originalCandidates })
    );
    try {
      assert.strictEqual(first.reused, false);
      const second = await loadOrCreateWorkflowDeploymentManifest(
        buildId,
        deploymentToken,
        async () => {
          throw new Error('retry must not resnapshot the production fleet');
        }
      );
      assert.strictEqual(second.reused, true);
      assert.deepStrictEqual(second.manifest.candidates, originalCandidates);
      assert.strictEqual(second.manifest.snapshotAt, snapshotAt.toISOString());
      await completeWorkflowDeploymentManifest(buildId, deploymentToken);
    } finally {
      await prisma.toolSideEffect.deleteMany({
        where: { externalId: `${buildId}:${deploymentToken}` },
      });
    }
  });

  finish();
  await prisma.$disconnect();
}

main().catch(async (error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  await prisma.$disconnect();
  process.exit(1);
});
