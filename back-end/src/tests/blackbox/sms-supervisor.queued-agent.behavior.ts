import type { PrismaClient } from '@prisma/client';

import {
  commitPendingWrites,
  dispatchToolCall,
  type PendingOp,
} from '../../providers/smsSupervisor/supervisorTools';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

const GOAL = 'Fill out and submit the Canada eTA application on canada.ca';
const NOTE = 'Passport G58219473 and US visa 72914836 are in the Travel docs note.';

/**
 * 2026-10-11 eTA benchmark (GPT-6 Sol): the model started an agent, read the
 * advertised "queued: will start agent [52bb10]", and replied to it in the
 * next round. reply_to_agent resolved only committed rows, so the id the
 * supervisor had just handed out was "No agent found". The start commit
 * creates exactly that id and pending writes commit in order, so the reply
 * must be queued against it and land on the new agent.
 */
async function testReplyToAgentQueuedThisRun(prisma: PrismaClient): Promise<void> {
  const userId = await provisionUserWithPhone(prisma, uniqueSmsPhone());
  try {
    const pendingWrites: PendingOp[] = [];
    const started = await dispatchToolCall(
      { tool: 'start_new_agent', arguments: { goal: GOAL, start_phase: 'plan' } },
      userId,
      pendingWrites
    );
    const prefix = /\[([0-9a-f]{6})\]/.exec(started.result)?.[1];
    if (!started.success || !prefix) {
      throw new Error(`start_new_agent did not advertise a prefix: ${JSON.stringify(started)}`);
    }

    const replied = await dispatchToolCall(
      { tool: 'reply_to_agent', arguments: { agent_id_or_prefix: prefix, message: NOTE } },
      userId,
      pendingWrites
    );
    if (!replied.success) {
      throw new Error(`reply to the queued agent was rejected: ${replied.error ?? ''}`);
    }
    const budget = await dispatchToolCall(
      { tool: 'increase_budget', arguments: { agent_id_or_prefix: prefix, amount_dollars: 1 } },
      userId,
      pendingWrites
    );
    if (!budget.success) {
      throw new Error(`increase_budget on the queued agent was rejected: ${budget.error ?? ''}`);
    }
    const [startOp] = pendingWrites;
    if (startOp?.kind !== 'start_new_agent') throw new Error('start op must commit first');
    const targets = pendingWrites
      .slice(1)
      .map((op) => (op.kind === 'start_new_agent' ? '' : op.agentId));
    if (targets.some((agentId) => agentId !== startOp.provisionalId)) {
      throw new Error(
        `queued writes target ${JSON.stringify(targets)}, not ${startOp.provisionalId}`
      );
    }

    const committed = await commitPendingWrites(pendingWrites, userId);
    const failed = committed.filter((result) => !result.success);
    if (failed.length > 0) throw new Error(`commit failed: ${JSON.stringify(failed)}`);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: startOp.provisionalId } });
    if (agent.goal !== GOAL || agent.priceLimitCents !== 200) {
      throw new Error(`unexpected agent row: ${JSON.stringify(agent)}`);
    }
    const delivered = await prisma.message.count({
      where: { agentId: agent.id, role: 'USER', text: NOTE },
    });
    if (delivered !== 1) throw new Error(`reply delivered ${delivered} times, expected 1`);
  } finally {
    await cleanupAgentScopedUser(prisma, userId);
  }
}

export function smsQueuedAgentBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'write-commit -- writes reach an agent queued earlier in the same run',
      fn: () => testReplyToAgentQueuedThisRun(prisma),
    },
  ];
}
