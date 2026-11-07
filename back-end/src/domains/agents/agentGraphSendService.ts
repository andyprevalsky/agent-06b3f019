import { formatInboundAgentMessage, type GraphMessageKind } from './agentGraphMessageFormat';
export { formatInboundAgentMessage, type GraphMessageKind } from './agentGraphMessageFormat';
/**
 * Agent graph send: one A2A message from a Rose agent or a code agent to any
 * agent / code agent of the same tree (scope rules in agentGraphService).
 *
 *   per-sender budget → a new message over it is 429 + Retry-After (sendBudget);
 *                       a retry of a delivered message is never limited
 *   Rose agent target → one USER row per (sender, message id); only the write
 *                       that creates it signals the workflow, and it never
 *                       lifts a user pause (deliverAgentGraphMessage)
 *   code agent target → deliverUserTurnToCodeSession (sender "agent"): the
 *                       CLI's next user turn, delivered once per message id
 *   code agent sender/target → child-scoped chip rows, so the code agent's
 *                       own timeline shows "<sender> → Codex" / "Codex → <target>"
 *   running code background task (send_message_to_agent recipient_task_id)
 *                     → deliverToRunningCodeTask (agentCodeTurnDelivery.ts)
 */
import { createMessage } from '../../providers/messages';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { takeSendBudget } from '../../providers/agentGraph/sendBudget';
import { createLogger } from '../../providers/logger';
import { isRoseDesktopUser } from '../../utils/roseDesktop';
import * as messageService from './agentMessageService';
import { codeLabel, recordCodeTimelineRow } from '../../providers/codeSessions/agentMessageRows';
import { deliverToCodeAgent, type CodeTarget } from './agentCodeTurnDelivery';
import * as graphRepo from './repoGraph';
import {
  AgentGraphError,
  NOT_FOUND,
  inCallerTree,
  resolveAlias,
  type GraphCaller,
} from './agentGraphService';

const log = createLogger('AgentGraph');

export interface SendInput {
  to: string;
  text: string;
  message_id: string;
}

export interface SendResult {
  message_id: string;
  status: 'delivered' | 'duplicate' | 'queued';
  to: { id: string; kind: 'agent' | 'code' };
}

type Target = { kind: 'agent'; id: string; title: string | null; isRoot: boolean } | CodeTarget;

function selfLabel(caller: GraphCaller): string {
  if (caller.self.kind === 'code') return codeLabel(caller.self.provider);
  return caller.self.id === caller.rootAgentId ? 'Root agent' : 'Agent';
}

function targetLabel(target: Target): string {
  if (target.kind === 'code') return codeLabel(target.provider);
  if (target.title !== null && target.title.trim() !== '') return target.title.trim();
  return target.isRoot ? 'Root agent' : 'Agent';
}

function senderMetadata(caller: GraphCaller): Record<string, unknown> {
  return caller.self.kind === 'code'
    ? {
        id: caller.self.id,
        kind: 'code',
        provider: caller.self.provider,
        owner_agent_id: caller.self.ownerAgentId,
      }
    : { id: caller.self.id, kind: 'agent' };
}

async function resolveTarget(caller: GraphCaller, to: string, account: boolean): Promise<Target> {
  const agent = await graphRepo.findGraphAgent(to);
  if (agent !== null) {
    if (agent.userId !== caller.userId || (!account && !(await inCallerTree(caller, agent.id)))) {
      throw new AgentGraphError(404, NOT_FOUND);
    }
    return {
      kind: 'agent',
      id: agent.id,
      title: agent.title,
      isRoot: agent.id === caller.rootAgentId,
    };
  }
  const session = await graphRepo.findGraphCodeSession(to);
  const sessionOwner = session === null ? null : await graphRepo.findGraphAgent(session.agentId);
  if (
    session !== null &&
    sessionOwner?.userId === caller.userId &&
    (account || (await inCallerTree(caller, session.agentId)))
  ) {
    const chip = await graphRepo.findCodeSessionChip(session.agentId, session.id);
    return {
      kind: 'code',
      id: session.id,
      ownerAgentId: session.agentId,
      streamUrl: session.streamUrl,
      status: session.status,
      provider: chip.provider,
      toolCallId: chip.toolCallId,
    };
  }
  throw new AgentGraphError(404, NOT_FOUND);
}

type AgentTarget = Extract<Target, { kind: 'agent' }>;

/**
 * Rose agent target: one USER row keyed by (target, sender key). Only the
 * call that writes the row signals the workflow, so concurrent attempts of
 * one send (a Temporal retry racing a slow first attempt) deliver once; an
 * agent's message never lifts the user's pause on the target.
 */
async function deliverToRoseAgent(args: {
  target: AgentTarget;
  key: string;
  text: string;
  title: string;
  a2a: Record<string, unknown>;
}): Promise<SendResult['status']> {
  const { created } = await messageService.deliverAgentGraphMessage(args.target.id, {
    message: args.text,
    metadata: { a2a: args.a2a, idempotencyKey: args.key, title: args.title },
  });
  return created ? 'delivered' : 'duplicate';
}

/** The row a completed delivery leaves on the target (a retry of it is free). */
async function alreadyDelivered(target: Target, key: string): Promise<boolean> {
  const id =
    target.kind === 'agent'
      ? deterministicMessageId(target.id, key)
      : deterministicMessageId(target.ownerAgentId, `${key}:received`);
  return (await graphRepo.findMessageById(id)) !== null;
}

/** Per-sender cap (sendBudget): a new message over budget → 429 + Retry-After. */
function spendSendBudget(caller: GraphCaller): void {
  const budget = takeSendBudget(caller.self.id);
  if (budget.ok) return;
  log.warn('Agent graph sender over its send budget', {
    from: caller.self.id,
    retry_after_s: budget.retryAfterSeconds,
  });
  throw new AgentGraphError(
    429,
    `Too many agent messages from this sender; retry in ${budget.retryAfterSeconds}s`,
    budget.retryAfterSeconds
  );
}

export async function sendGraphMessage(
  caller: GraphCaller,
  input: SendInput,
  kind: GraphMessageKind = 'message',
  account = false
): Promise<SendResult> {
  if (account && caller.accountAccess !== true)
    throw new AgentGraphError(403, 'This session has no account-agent access');
  const to = await resolveAlias(caller, input.to);
  if (to === caller.self.id) throw new AgentGraphError(400, 'Cannot message yourself');
  const target = await resolveTarget(caller, to, account);
  // Keyed by sender so two agents can never collide on a client-chosen id.
  const key = `a2a:${caller.self.id}:${input.message_id}`;
  const fromLabel = selfLabel(caller);
  const toLabel = targetLabel(target);
  const a2a = {
    kind,
    message_id: input.message_id,
    from: { ...senderMetadata(caller), label: fromLabel },
    to: { id: target.id, kind: target.kind, label: toLabel },
    // The sender's words without the LLM framing, for UI rendering.
    text: input.text,
  };
  const text = formatInboundAgentMessage({
    senderLabel: fromLabel,
    senderId: caller.self.id,
    recipientKind: target.kind,
    account,
    kind,
    text: input.text,
  });

  const title = `${fromLabel} → ${toLabel}`;
  if (!(await alreadyDelivered(target, key))) spendSendBudget(caller);
  const status =
    target.kind === 'agent'
      ? await deliverToRoseAgent({ target, key, text, title, a2a })
      : await deliverToCodeAgent({ target, key, text, title, a2a, original: input.text });

  if (caller.self.kind === 'code') {
    const chip = await graphRepo.findCodeSessionChip(caller.self.ownerAgentId, caller.self.id);
    await recordCodeTimelineRow({
      ownerAgentId: caller.self.ownerAgentId,
      sessionId: caller.self.id,
      provider: caller.self.provider,
      toolCallId: chip.toolCallId,
      key,
      title,
      text: input.text,
      a2a,
      direction: 'sent',
    });
  } else if (isRoseDesktopUser(caller.userId)) {
    // A delivery receipt for the user's activity view, never another model turn.
    // Include the recipient so reusing a client id across targets stays distinct.
    await createMessage({
      agentId: caller.self.id,
      role: 'TOOL',
      text: input.text,
      metadata: {
        a2a: { ...a2a, direction: 'sent' },
        idempotencyKey: `${key}:to:${target.id}:sent`,
        title,
        action_type: 'agent_message',
        excludeFromModel: true,
      },
    });
  }

  log.info('Delivered agent graph message', {
    from: caller.self.id,
    to: target.id,
    toKind: target.kind,
    kind,
    key,
    status,
  });
  return { message_id: input.message_id, status, to: { id: target.id, kind: target.kind } };
}
