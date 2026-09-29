#!/usr/bin/env tsx
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  agentNeedsCutoverRecovery,
  clearSupersededGenerationWorkflow,
  GENERATION_CUTOVER_STATUS_PREFIX,
  setCutoverRestartForTests,
} from '../../providers/generationQueueCutover';
import { claimReplacementGeneration } from '../../providers/workflowReplacementPreparation';
import { DEPLOY_INTERRUPTED_TOOL_MESSAGE } from '../../providers/workflowGeneration';
import { commitPendingWrites } from '../../providers/smsSupervisor/supervisorTools';
import { createTestHarness } from './trace-archive-test-utils'; // pragma: allowlist secret

const { test, finish } = createTestHarness('generation queue cutover unit tests');

const ALL_AGENT_STATUSES = [
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
] as const;

async function createAgent(overrides: {
  status?: (typeof ALL_AGENT_STATUSES)[number];
  statusMessage?: string | null;
  temporalWorkflowId?: string;
}): Promise<string> {
  const id = randomUUID();
  await prisma.agent.create({
    data: {
      id,
      userId: `generation-cutover-unit-${id}`,
      goal: 'Buy Oral-B Glide floss after user approval',
      status: overrides.status ?? 'ACTIVE',
      statusMessage: overrides.statusMessage ?? null,
      temporalWorkflowId: overrides.temporalWorkflowId ?? id,
      busId: id,
    },
  });
  return id;
}

async function withAgent(
  overrides: Parameters<typeof createAgent>[0],
  fn: (agentId: string) => Promise<void>
): Promise<void> {
  const agentId = await createAgent(overrides);
  try {
    await fn(agentId);
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { agentId } });
    await prisma.message.deleteMany({ where: { agentId } });
    await prisma.agent.deleteMany({ where: { id: agentId } });
  }
}

async function main(): Promise<void> {
  await test('force-clear replaces an approval-blocked agent instead of marking it FAILED', async () => {
    const workflowId = `approval-wait-${randomUUID()}`;
    await withAgent({ temporalWorkflowId: workflowId }, async (agentId) => {
      await prisma.agentAttentionRequest.create({
        data: {
          id: `attn_${agentId.slice(0, 12)}`,
          userId: `generation-cutover-unit-${agentId}`,
          agentId,
          workflowId,
          question: 'Approve the Amazon purchase?',
          metadata: { requestUserApproval: true, writePermission: true },
        },
      });

      let restartedAgentId: string | null = null;
      const outcome = await clearSupersededGenerationWorkflow(
        'navi-agent-tasks@b50a500a6097',
        workflowId,
        {
          restartAgent: async (id) => {
            restartedAgentId = id;
            return {
              success: true,
              agent_id: id,
              workflow_id: `${id}:replacement:${randomUUID()}`,
            };
          },
          terminateOrphan: async () => {
            throw new Error('owned agent must not be treated as an orphan');
          },
        }
      );

      assert.strictEqual(outcome, 'cleared');
      assert.strictEqual(restartedAgentId, agentId);
      const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
      assert.notStrictEqual(
        stored.status,
        'FAILED',
        'approval-blocked cutover stragglers must be replaced, not marked FAILED'
      );
      assert.notStrictEqual(
        stored.statusMessage?.startsWith(GENERATION_CUTOVER_STATUS_PREFIX) ?? false,
        true,
        'cutover must not write a Generation cutover FAILED statusMessage'
      );
    });
  });

  await test('force-clear replaces owned agents in every AgentStatus', async () => {
    for (const status of ALL_AGENT_STATUSES) {
      const workflowId = `status-${status}-${randomUUID()}`;
      await withAgent({ status, temporalWorkflowId: workflowId }, async (agentId) => {
        let restartedAgentId: string | null = null;
        const outcome = await clearSupersededGenerationWorkflow(
          'navi-agent-tasks@old',
          workflowId,
          {
            restartAgent: async (id) => {
              restartedAgentId = id;
              return {
                success: true,
                agent_id: id,
                workflow_id: `${id}:replacement:${randomUUID()}`,
              };
            },
            terminateOrphan: async () => {
              throw new Error(`${status} agent must not be treated as an orphan`);
            },
          }
        );
        assert.strictEqual(outcome, 'cleared', `${status} must be replaced`);
        assert.strictEqual(restartedAgentId, agentId, `${status} must restart`);
        const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
        assert.notStrictEqual(
          stored.statusMessage?.startsWith(GENERATION_CUTOVER_STATUS_PREFIX) ?? false,
          true,
          `${status} must not receive a Generation cutover FAILED statusMessage`
        );
      });
    }
  });

  await test('orphan workflows with no agent row are terminated', async () => {
    let terminated: string | null = null;
    const workflowId = `orphan-${randomUUID()}`;
    const outcome = await clearSupersededGenerationWorkflow('navi-agent-tasks@old', workflowId, {
      findAgentByWorkflowId: async () => null,
      restartAgent: async () => {
        throw new Error('orphan must not be restarted');
      },
      terminateOrphan: async (id) => {
        terminated = id;
        return 'cleared';
      },
    });
    assert.strictEqual(outcome, 'cleared');
    assert.strictEqual(terminated, workflowId);
  });

  await test('agentNeedsCutoverRecovery matches the prod FAILED + sealed shape', () => {
    assert.strictEqual(
      agentNeedsCutoverRecovery({
        status: 'FAILED',
        statusMessage:
          'Generation cutover: terminated workflow still on superseded queue navi-agent-tasks@b50a500a6097',
        temporalWorkflowId:
          '3eb6da5a-280a-4456-a410-6b1799b06349:deployment-sealed:1140a40c-fa8b-4b8a-916f-929a52f0a0e7',
      }),
      true
    );
    assert.strictEqual(
      agentNeedsCutoverRecovery({
        status: 'FAILED',
        statusMessage: 'LLM crashed',
        temporalWorkflowId: 'agent-1',
      }),
      false
    );
    assert.strictEqual(
      agentNeedsCutoverRecovery({
        status: 'ACTIVE',
        statusMessage: null,
        temporalWorkflowId: 'agent-1',
      }),
      false
    );
    assert.strictEqual(
      DEPLOY_INTERRUPTED_TOOL_MESSAGE,
      'new code version deployed, retry this tool'
    );
  });

  await test('user-initiated replacement claim recovers a FAILED cutover agent', async () => {
    const workflowId = `${randomUUID()}:deployment-sealed:${randomUUID()}`;
    await withAgent(
      {
        status: 'FAILED',
        statusMessage: `${GENERATION_CUTOVER_STATUS_PREFIX} terminated workflow still on superseded queue navi-agent-tasks@old`,
        temporalWorkflowId: workflowId,
      },
      async (agentId) => {
        const snapshotClaim = await claimReplacementGeneration(
          agentId,
          undefined,
          workflowId,
          'build:attempt'
        );
        assert(
          'skipped' in snapshotClaim,
          'deploy snapshot claims must still skip FAILED candidates'
        );

        const userClaim = await claimReplacementGeneration(agentId, undefined, null, undefined);
        assert(
          !('skipped' in userClaim),
          'user-initiated restart must recover a FAILED cutover agent'
        );
        assert.strictEqual(userClaim.staleWorkflowId, workflowId);
      }
    );
  });

  await test('explicit expectedWorkflowId still fences without a deployment attempt', async () => {
    const workflowId = `${randomUUID()}:deployment-sealed:${randomUUID()}`;
    await withAgent(
      {
        status: 'FAILED',
        statusMessage: `${GENERATION_CUTOVER_STATUS_PREFIX} terminated workflow still on superseded queue navi-agent-tasks@old`,
        temporalWorkflowId: workflowId,
      },
      async (agentId) => {
        const fencedClaim = await claimReplacementGeneration(
          agentId,
          undefined,
          workflowId,
          undefined
        );
        assert(
          'skipped' in fencedClaim,
          'migrate/snapshot claims must skip FAILED even without deploymentAttempt'
        );
      }
    );
  });

  await test('late SMS approve of a fenced cutover agent restarts instead of dead-ending', async () => {
    const workflowId = `${randomUUID()}:deployment-sealed:${randomUUID()}`;
    await withAgent(
      {
        status: 'FAILED',
        statusMessage: `${GENERATION_CUTOVER_STATUS_PREFIX} terminated workflow still on superseded queue navi-agent-tasks@old`,
        temporalWorkflowId: workflowId,
      },
      async (agentId) => {
        const attentionId = randomUUID();
        await prisma.agentAttentionRequest.create({
          data: {
            id: attentionId,
            userId: `generation-cutover-unit-${agentId}`,
            agentId,
            workflowId,
            question: 'Approve the Amazon purchase?',
            userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE,
            metadata: { requestUserApproval: true },
          },
        });

        let restarted: string | null = null;
        setCutoverRestartForTests(async (id) => {
          restarted = id;
          return { success: true, agent_id: id };
        });
        try {
          const results = await commitPendingWrites(
            [
              {
                kind: 'reply_to_agent',
                args: {
                  agent_id_or_prefix: agentId.substring(0, 6),
                  attention_request_id: attentionId,
                  message: 'approve',
                  reject: false,
                },
                agentId,
              },
            ],
            `generation-cutover-unit-${agentId}`
          );
          assert.strictEqual(results[0]?.success, true);
          assert.match(
            results[0]?.result ?? '',
            /Approved after deploy interruption and restarted/
          );
          assert.strictEqual(restarted, agentId);
        } finally {
          setCutoverRestartForTests(null);
        }
      }
    );
  });
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    finish();
    await prisma.$disconnect();
  });
