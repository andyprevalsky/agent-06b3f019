import {
  assert,
  createAnonymousSession,
  createTestAgent,
  prisma,
  randomUUID,
  test,
} from './agents-blackbox-harness';
import { prepareAgentWorkflowReplacement } from '../../domains/agents/agentRestartService';
import {
  clearSupersededGenerationWorkflow,
  GENERATION_CUTOVER_STATUS_PREFIX,
} from '../../providers/generationQueueCutover';

const ALL_AGENT_STATUSES = [
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
] as const;

/**
 * Force-clear of a superseded-queue straggler must REPLACE the agent.
 * The prod bug: an approval-blocked parent was marked FAILED, so a late
 * SMS approve could not recover it. Owned agents of every status go through
 * the same replace path as POST /restart.
 */
test('force-clear replaces an approval-blocked agent instead of marking it FAILED', async () => {
  const session = await createAnonymousSession('cutover-replace-approval');
  const agentId = await createTestAgent(session.user.id, 'Approve the Amazon purchase?');
  const workflowId = `${agentId}:approval-wait`;
  await prisma.agent.update({
    where: { id: agentId },
    data: { temporalWorkflowId: workflowId, status: 'ACTIVE' },
  });
  await prisma.agentAttentionRequest.create({
    data: {
      id: `attn_${agentId.slice(0, 12)}`,
      userId: session.user.id,
      agentId,
      workflowId,
      question: 'Approve the Amazon purchase?',
      metadata: { requestUserApproval: true, writePermission: true },
    },
  });

  let restartedAgentId: string | null = null;
  const outcome = await clearSupersededGenerationWorkflow('navi-agent-tasks@old', workflowId, {
    restartAgent: async (id) => {
      restartedAgentId = id;
      await prepareAgentWorkflowReplacement(id, session.user.id);
      return {
        success: true,
        agent_id: id,
        workflow_id: `${id}:replacement:${randomUUID()}`,
      };
    },
    terminateOrphan: async () => {
      throw new Error('owned approval-blocked agent must not be treated as an orphan');
    },
  });

  assert(outcome === 'cleared', `force-clear must replace, got ${outcome}`);
  assert(restartedAgentId === agentId, 'force-clear must restart the parked agent');
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
  assert(
    stored.status !== 'FAILED',
    `approval-blocked cutover stragglers must be replaced, not marked FAILED (status=${stored.status})`
  );
  assert(
    !stored.statusMessage?.startsWith(GENERATION_CUTOVER_STATUS_PREFIX),
    `cutover must not write a Generation cutover FAILED statusMessage: ${stored.statusMessage}`
  );
});

test('force-clear replaces HTTP-created agents in every AgentStatus', async () => {
  for (const status of ALL_AGENT_STATUSES) {
    const session = await createAnonymousSession(`cutover-replace-${status.toLowerCase()}`);
    const agentId = await createTestAgent(session.user.id, `Force-clear ${status} agent`);
    const workflowId = `${agentId}:${status}`;
    await prisma.agent.update({
      where: { id: agentId },
      data: { temporalWorkflowId: workflowId, status },
    });

    let restartedAgentId: string | null = null;
    const outcome = await clearSupersededGenerationWorkflow('navi-agent-tasks@old', workflowId, {
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
    });

    assert(outcome === 'cleared', `${status} must be replaced, got ${outcome}`);
    assert(restartedAgentId === agentId, `${status} must restart`);
    const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    assert(
      !stored.statusMessage?.startsWith(GENERATION_CUTOVER_STATUS_PREFIX),
      `${status} must not receive a Generation cutover FAILED statusMessage`
    );
  }
});
