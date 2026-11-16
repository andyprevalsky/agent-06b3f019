/**
 * Which agent trees the user touched from the phone: the SMS/WhatsApp agent
 * (the messaging supervisor) acted on them in response to the user's message.
 *
 * Kickoff and completion notices on SMS/WhatsApp go only to those trees (Andy,
 * 2026-11-12: "Only show completed agents notif if the sms / whatsapp agent has
 * interacted w that agent"; 2026-11-14: "only trigger messaging notifs when an
 * agent has been touched by the messaging client" and "a touch should be if I
 * respond and we reply"). A touch is one of:
 *
 *   created   Agent.source SMS | WHATSAPP   (commitStartNewAgent)
 *   replied   reply_to_agent commit: an answer, approval or rejection (marker below)
 *   budget    increase_budget commit (marker below)
 *
 * Relays are NOT touches: a question, approval, sign-in, AgentCard setup or
 * budget-limit notice delivered to the phone is something the agent sent, not
 * something the user did. The user's answer to one is a reply_to_agent touch.
 * Neither is the kickoff receipt ("I'm on it"); it is itself gated on a touch.
 * kill_agent deletes the agent, and a deleted agent sends nothing.
 *
 *   supervisor reply_to_agent / increase_budget commit
 *        │  recordMessagingAgentInteraction(agentId, kind)
 *        ▼
 *   ToolSideEffect "messaging-agent.interaction:<rootId>"  (one row per tree)
 *        ▲
 *        │  hasMessagingAgentInteraction(root)  ── unique-key lookup
 *   kickoff + completion notify (send-sms dispatchNotification)
 *
 * One row per root keeps the check a unique-key lookup however large the tree
 * is. Rows written before 2026-11-14 may carry a relay kind; those do not count,
 * and the next touch overwrites them. Only when no touch row exists does the
 * check fall back to the root's own `sms_supervisor` USER message, a scan
 * bounded by that one agent's messages.
 */

import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('MessagingAgentInteraction');

export const MESSAGING_AGENT_INTERACTION_OPERATION_TYPE = 'messaging-agent.interaction';

/** Message.metadata.source written by the supervisor's reply_to_agent commit. */
export const SMS_SUPERVISOR_MESSAGE_SOURCE = 'sms_supervisor';

/** Bound on the parent walk for rows whose busId is missing (spawn depth is far lower). */
const MAX_ROOT_WALK = 64;

const TOUCH_KINDS = ['reply_to_agent', 'increase_budget'] as const;

export type MessagingAgentInteractionKind = (typeof TOUCH_KINDS)[number];

function isTouchKind(kind: unknown): boolean {
  return TOUCH_KINDS.some((touch) => touch === kind);
}

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
 * Durably mark the agent's tree as touched from the phone. Idempotent: the
 * latest touch overwrites the row, replacing any legacy relay kind. Best-effort:
 * the reply has already happened, so a marker failure is logged, never thrown.
 */
export async function recordMessagingAgentInteraction(
  agentId: string,
  kind: MessagingAgentInteractionKind
): Promise<void> {
  try {
    const rootAgentId = await resolveRootAgentId(agentId);
    if (rootAgentId === null) return;
    const operationKey = messagingAgentInteractionKey(rootAgentId);
    const request = { agent_id: agentId, kind };
    await prisma.toolSideEffect.upsert({
      where: { operationKey },
      create: {
        operationKey,
        operationType: MESSAGING_AGENT_INTERACTION_OPERATION_TYPE,
        status: 'SUCCEEDED',
        request,
      },
      update: { request },
    });
  } catch (error) {
    log.error('Failed to record messaging-agent interaction', {
      agentId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Whether the SMS/WhatsApp agent created, replied to or raised the budget of this root. */
export async function hasMessagingAgentInteraction(agent: {
  id: string;
  /** Agent.source (AgentSource enum value). */
  source: string;
}): Promise<boolean> {
  if (isMessagingSource(agent.source)) return true;
  const marker = await prisma.toolSideEffect.findUnique({
    where: { operationKey: messagingAgentInteractionKey(agent.id) },
    select: { request: true },
  });
  const request = marker?.request;
  if (
    request !== null &&
    request !== undefined &&
    typeof request === 'object' &&
    !Array.isArray(request) &&
    isTouchKind(request.kind)
  ) {
    return true;
  }
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
