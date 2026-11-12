/**
 * Which agent trees the SMS/WhatsApp agent (the messaging supervisor) has
 * interacted with.
 *
 * Completion notices on SMS/WhatsApp go only to those trees (Andy, 2026-11-12:
 * "Only show completed agents notif if the sms / whatsapp agent has interacted
 * w that agent"). An interaction is one of:
 *
 *   created   Agent.source SMS | WHATSAPP            (commitStartNewAgent)
 *   messaged  reply_to_agent / increase_budget commit (marker below)
 *   relayed   a question, approval, sign-in, AgentCard setup or budget-limit
 *             update delivered on the messaging thread (marker below)
 *
 * The kickoff receipt ("I'm on it") is deliberately NOT an interaction: every
 * root agent sends one, so counting it would keep texting completions for
 * agents started on the web.
 *
 *   supervisor commit / relay delivered
 *        │  recordMessagingAgentInteraction(agentId)
 *        ▼
 *   ToolSideEffect "messaging-agent.interaction:<rootId>"  (one row per tree)
 *        ▲
 *        │  hasMessagingAgentInteraction(root)  ── unique-key lookup
 *   completion notify (send-sms dispatchCompletionOnce)
 *
 * One row per root keeps the completion check O(1) however large the tree is.
 * Replies posted before this marker existed are still found through the
 * root's own `sms_supervisor` USER message.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('MessagingAgentInteraction');

export const MESSAGING_AGENT_INTERACTION_OPERATION_TYPE = 'messaging-agent.interaction';

/** Message.metadata.source written by the supervisor's reply_to_agent commit. */
export const SMS_SUPERVISOR_MESSAGE_SOURCE = 'sms_supervisor';

export type MessagingAgentInteractionKind =
  | 'reply_to_agent'
  | 'increase_budget'
  | 'planner_message'
  | 'write_lock'
  | 'auth_assistance'
  | 'agentcard_setup'
  | 'cost_limit';

export function messagingAgentInteractionKey(rootAgentId: string): string {
  return `${MESSAGING_AGENT_INTERACTION_OPERATION_TYPE}:${rootAgentId}`;
}

function isMessagingSource(source: string): boolean {
  return source === 'SMS' || source === 'WHATSAPP';
}

/**
 * Durably mark the agent's tree as one the messaging agent interacted with.
 * Idempotent (first interaction wins). Best-effort: the reply or relay has
 * already happened, so a marker failure is logged and never thrown.
 */
export async function recordMessagingAgentInteraction(
  agentId: string,
  kind: MessagingAgentInteractionKind
): Promise<void> {
  try {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { parentAgentId: true, busId: true },
    });
    if (!agent) return;
    const rootAgentId = agent.parentAgentId === null ? agentId : (agent.busId ?? agentId);
    await prisma.toolSideEffect.createMany({
      data: [
        {
          operationKey: messagingAgentInteractionKey(rootAgentId),
          operationType: MESSAGING_AGENT_INTERACTION_OPERATION_TYPE,
          status: 'SUCCEEDED',
          request: { agent_id: agentId, kind },
        },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    log.error('Failed to record messaging-agent interaction', {
      agentId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether the SMS/WhatsApp agent created, messaged or relayed for this root. */
export async function hasMessagingAgentInteraction(agent: {
  id: string;
  /** Agent.source (AgentSource enum value). */
  source: string;
}): Promise<boolean> {
  if (isMessagingSource(agent.source)) return true;
  const [marker, reply] = await Promise.all([
    prisma.toolSideEffect.findUnique({
      where: { operationKey: messagingAgentInteractionKey(agent.id) },
      select: { id: true },
    }),
    prisma.message.findFirst({
      where: {
        agentId: agent.id,
        role: 'USER',
        metadata: { path: ['source'], equals: SMS_SUPERVISOR_MESSAGE_SOURCE },
      },
      select: { id: true },
    }),
  ]);
  return marker !== null || reply !== null;
}
