import type { AgentStatus, PrismaClient } from '@prisma/client';

import { commitPendingWrites } from '../../providers/smsSupervisor/supervisorTools';
import { getTemporalClient } from '../../providers/temporal';
import { blackboxTemporalSignals } from '../../providers/temporalBlackboxFake';
import {
  cleanupAgentScopedUser,
  provisionUserWithPhone,
  uniqueSmsPhone,
} from './sms-supervisor.helpers';

const REDIRECT =
  'Skip DoorDash entirely. Buy the newest AirPods Pro from Apple.com or Amazon.com instead.';

async function cleanupPausedReplyRun(prisma: PrismaClient, userId: string) {
  await prisma.agentAttentionRequest.deleteMany({ where: { userId } });
  await cleanupAgentScopedUser(prisma, userId);
}

async function commitReplyToAgentWithStatus(
  prisma: PrismaClient,
  status: AgentStatus,
  options: { asAttentionApproval?: boolean } = {}
) {
  const userId = await provisionUserWithPhone(prisma, uniqueSmsPhone());
  const temporal = await getTemporalClient();
  const agent = await prisma.agent.create({
    data: {
      userId,
      goal: 'Buy the newest AirPods Pro with noise cancellation',
      status,
      source: 'SMS',
    },
  });
  await temporal.workflow.start('AgentWorkflow', {
    workflowId: agent.id,
    taskQueue: 'blackbox',
    args: [],
  });
  await prisma.agent.update({ where: { id: agent.id }, data: { temporalWorkflowId: agent.id } });
  const attention = options.asAttentionApproval
    ? await prisma.agentAttentionRequest.create({
        data: {
          userId,
          agentId: agent.id,
          workflowId: agent.id,
          question: 'Place the AirPods Pro order for $249?',
        },
      })
    : null;

  const [result] = await commitPendingWrites(
    [
      {
        kind: 'reply_to_agent',
        args: {
          agent_id_or_prefix: agent.id.substring(0, 6),
          message: REDIRECT,
          ...(attention ? { attention_request_id: attention.id } : {}),
        },
        agentId: agent.id,
      },
    ],
    userId
  );
  const stored = await prisma.agent.findUniqueOrThrow({ where: { id: agent.id } });
  const delivered = await prisma.message.count({
    where: { agentId: agent.id, role: 'USER', text: REDIRECT },
  });
  return {
    userId,
    result,
    stored,
    delivered,
    signals: blackboxTemporalSignals(temporal, agent.id).map((signal) => signal.name),
  };
}

/**
 * Prod agent 5c8b0ca4 (2026-10-01): the user paused it, later texted
 * "Skip DoorDash entirely…", and the supervisor's reply_to_agent posted the
 * message and signaled receive_user_response — but nothing resumed the
 * workflow, so it sat PAUSED with the new instruction unread.
 */
export async function testReplyToAgent_resumesPausedAgentAfterDeliveringMessage(
  prisma: PrismaClient
) {
  const run = await commitReplyToAgentWithStatus(prisma, 'PAUSED');
  try {
    if (run.result?.success !== true) {
      throw new Error(
        `Expected reply_to_agent commit to succeed, got ${JSON.stringify(run.result)}`
      );
    }
    if (run.delivered !== 1) {
      throw new Error(
        `Expected the reply to be posted once as a USER message, got ${run.delivered}`
      );
    }
    if (run.stored.status !== 'ACTIVE') {
      throw new Error(
        `Expected an SMS reply to resume the PAUSED agent, status is still ${run.stored.status}`
      );
    }
    if (JSON.stringify(run.signals) !== JSON.stringify(['receive_user_response', 'resume'])) {
      throw new Error(
        'Expected the message signal to land before the resume signal, got ' +
          JSON.stringify(run.signals)
      );
    }
  } finally {
    await cleanupPausedReplyRun(prisma, run.userId);
  }
}

export async function testReplyToAgent_leavesCostLimitedAgentForBudgetIncrease(
  prisma: PrismaClient
) {
  const run = await commitReplyToAgentWithStatus(prisma, 'COST_LIMIT_REACHED');
  try {
    if (run.result?.success !== true || run.delivered !== 1) {
      throw new Error(`Expected the reply to be delivered, got ${JSON.stringify(run.result)}`);
    }
    if (run.stored.status !== 'COST_LIMIT_REACHED') {
      throw new Error(`A reply must not lift a cost limit, status became ${run.stored.status}`);
    }
    if (JSON.stringify(run.signals) !== JSON.stringify(['receive_user_response'])) {
      throw new Error(
        `A cost-limited agent must only receive the message, got ${JSON.stringify(run.signals)}`
      );
    }
  } finally {
    await cleanupPausedReplyRun(prisma, run.userId);
  }
}

export async function testReplyToAgent_attentionDecisionResumesPausedAgent(prisma: PrismaClient) {
  const run = await commitReplyToAgentWithStatus(prisma, 'PAUSED', { asAttentionApproval: true });
  try {
    if (run.result?.success !== true) {
      throw new Error(`Expected the approval to be delivered, got ${JSON.stringify(run.result)}`);
    }
    if (run.stored.status !== 'ACTIVE') {
      throw new Error(
        `An approval texted to a PAUSED agent must resume it, status is still ${run.stored.status}`
      );
    }
    if (JSON.stringify(run.signals) !== JSON.stringify(['receive_user_response', 'resume'])) {
      throw new Error(
        `Expected the decision signal before the resume signal, got ${JSON.stringify(run.signals)}`
      );
    }
  } finally {
    await cleanupPausedReplyRun(prisma, run.userId);
  }
}

export function smsPausedReplyBehaviorCases(prisma: PrismaClient) {
  return [
    {
      name: 'reply_to_agent -- resumes a PAUSED agent after delivering the message',
      fn: () => testReplyToAgent_resumesPausedAgentAfterDeliveringMessage(prisma),
    },
    {
      name: 'reply_to_agent -- leaves a cost-limited agent for increase_budget',
      fn: () => testReplyToAgent_leavesCostLimitedAgentForBudgetIncrease(prisma),
    },
    {
      name: 'reply_to_agent -- an attention decision resumes a PAUSED agent',
      fn: () => testReplyToAgent_attentionDecisionResumesPausedAgent(prisma),
    },
  ];
}
