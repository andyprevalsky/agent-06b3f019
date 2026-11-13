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
 * One row per root keeps the completion check a unique-key lookup however large
 * the tree is. Only when that row is missing (untouched agents, or replies posted
 * before this marker existed) does it fall back to the root's own
 * `sms_supervisor` USER message, a scan bounded by that one agent's messages.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('MessagingAgentInteraction');

export const MESSAGING_AGENT_INTERACTION_OPERATION_TYPE = 'messaging-agent.interaction';

/** Message.metadata.source written by the supervisor's reply_to_agent commit. */
export const SMS_SUPERVISOR_MESSAGE_SOURCE = 'sms_supervisor';

/** Bound on the parent walk for rows whose busId is missing (spawn depth is far lower). */
const MAX_ROOT_WALK = 64;

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
 * The tree's root: the agent itself for a root, its busId for a descendant, or
 * (rows restored without a busId) the end of its parentAgentId chain.
 */
async function resolveRootAgentId(agentId: string): Promise<string | null> {
  let currentId = agentId;
  for (let hop = 0; hop < MAX_ROOT_WALK; hop += 1) {
    const agent = await prisma.agent.findUnique({
      where: { id: currentId },
      select: { parentAgentId: true, busId: true },
    });
    if (!agent) return hop === 0 ? null : currentId;
    if (agent.parentAgentId === null) return currentId;
    if (agent.busId !== null && agent.busId !== currentId) return agent.busId;
    currentId = agent.parentAgentId;
  }
  log.warn('Root walk exceeded its bound; marking the last ancestor reached', {
    agentId,
    lastAncestorId: currentId,
  });
  return currentId;
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
    const rootAgentId = await resolveRootAgentId(agentId);
    if (rootAgentId === null) return;
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
  const marker = await prisma.toolSideEffect.findUnique({
    where: { operationKey: messagingAgentInteractionKey(agent.id) },
    select: { id: true },
  });
  if (marker !== null) return true;
  const reply = await prisma.message.findFirst({
    where: {
      agentId: agent.id,
      role: 'USER',
      metadata: { path: ['source'], equals: SMS_SUPERVISOR_MESSAGE_SOURCE },
    },
    select: { id: true },
  });
  return reply !== null;
}
