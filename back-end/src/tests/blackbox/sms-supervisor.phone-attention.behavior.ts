/** Pending native attention -> secure view; SMS tool replies cannot write or resume it. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  commitPendingWrites,
  dispatchToolCall,
  type PendingOp,
} from '../../providers/smsSupervisor/supervisorTools';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

async function nativeReply(prisma: PrismaClient, mode: 'dispatch' | 'commit' | 'no-id') {
  const userId = await provisionUserWithPhone(prisma, uniqueSmsPhone());
  const agent = await prisma.agent.create({
    data: { userId, goal: 'Set up my cloud phone', status: 'ACTIVE', source: 'SMS' },
  });
  const temporal = await getTemporalClient();
  await temporal.workflow.start('AgentWorkflow', {
    workflowId: agent.id,
    taskQueue: 'blackbox',
    args: [],
  });
  await prisma.agent.update({ where: { id: agent.id }, data: { temporalWorkflowId: agent.id } });
  const target = { kind: 'iphone', browserTaskId: randomUUID(), leaseId: randomUUID() };
  const attention = await prisma.agentAttentionRequest.create({
    data: {
      userId,
      agentId: agent.id,
      workflowId: agent.id,
      question: 'Complete the protected step on your iPhone',
      metadata: { target, criticalReason: 'password', authAssistance: { target } },
      authAssistance: {
        create: {
          userId,
          agentId: agent.id,
          authRealm: 'iphone',
          mode: 'manual_step',
          steelSessionId: '',
        },
      },
    },
  });
  const canary = `unregistered-sms-input-${randomUUID()}`;
  const args = {
    agent_id_or_prefix: agent.id,
    message: canary,
    ...(mode === 'no-id' ? {} : { attention_request_id: attention.id }),
  };
  const beforeSignals = blackboxTemporalSignals(temporal, agent.id).length;
  try {
    const pending: PendingOp[] = [];
    const result =
      mode === 'dispatch'
        ? await dispatchToolCall({ tool: 'reply_to_agent', arguments: args }, userId, pending)
        : (
            await commitPendingWrites([{ kind: 'reply_to_agent', args, agentId: agent.id }], userId)
          )[0];
    const stored = await prisma.agentAttentionRequest.findUniqueOrThrow({
      where: { id: attention.id },
    });
    const authored = await prisma.message.count({ where: { agentId: agent.id, role: 'USER' } });
    assert.equal(result?.success, false, 'Native phone SMS reply must use the secure view');
    assert.equal(pending.length, 0, 'Native phone reply must not enter deferred writes');
    assert.equal(stored.userResponse, null, 'SMS must not answer native attention');
    assert.equal(authored, 0, 'SMS private input must not enter the agent conversation');
    assert.equal(
      blackboxTemporalSignals(temporal, agent.id).length,
      beforeSignals,
      'SMS must not resume native attention'
    );
    assert.equal(JSON.stringify(result).includes(canary), false, 'Error must not echo input');
    const url = new URL(result?.error?.match(/https?:\/\/\S+/)?.[0] ?? 'https://invalid.test');
    assert.equal(
      url.searchParams.get('attention-request-id'),
      attention.id,
      'Secure link must identify exact attention'
    );
    assert.equal(
      url.searchParams.get('browser-id'),
      target.browserTaskId,
      'Secure link must identify exact task'
    );
  } finally {
    await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function smsPhoneAttentionBehaviorCases(prisma: PrismaClient) {
  return (['dispatch', 'commit', 'no-id'] as const).map((mode) => ({
    name: `native phone attention -- SMS ${mode} cannot persist or resume private input`,
    fn: () => nativeReply(prisma, mode),
  }));
}
