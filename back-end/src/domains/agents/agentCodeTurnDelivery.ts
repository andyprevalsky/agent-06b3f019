/**
 * Code agent turns: a message to a code session is the live CLI's next user
 * turn (ws-server user_turn protocol, sender "agent"), delivered once per
 * message id, plus a child-scoped chip row on the session's owner.
 *
 *   agent-graph send to a code session ─┐
 *   send_message_to_agent to a RUNNING  ├─▶ deliverToCodeAgent ─▶ CLI turn
 *   code background task ───────────────┘    (deliverToRunningCodeTask)
 *
 * No question path: code agents only receive messages here.
 */
import { createHash } from 'node:crypto';
import { createMessage } from '../../providers/messages';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { deliverUserTurnToCodeSession, type TurnDelivery } from '../../providers/codeSessionTurns';
import { formatInboundAgentMessage } from './agentGraphMessageFormat';
import { takeSendBudget } from '../../providers/agentGraph/sendBudget';
import * as graphRepo from './repoGraph';
import { AgentGraphError, type CodeProvider } from './agentGraphService';

export interface CodeTarget {
  kind: 'code';
  id: string;
  ownerAgentId: string;
  streamUrl: string | null;
  status: string;
  provider: CodeProvider | null;
  toolCallId: string | null;
}

const PROVIDER_LABEL: Record<CodeProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export function codeLabel(provider: CodeProvider | null): string {
  return provider === null ? 'Code agent' : PROVIDER_LABEL[provider];
}

/** ws-server turn ids are bounded; derive a stable short id from the key. */
function codeTurnId(key: string): string {
  return `a2a-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

function deliveryError(delivery: TurnDelivery): AgentGraphError {
  if (delivery.status === 'unreachable') {
    return new AgentGraphError(502, 'Could not reach the code agent session');
  }
  if (delivery.reason === 'session_ended') {
    return new AgentGraphError(409, 'Code agent session has finished');
  }
  if (delivery.reason === 'relay_paused') {
    // The user holds the session in direct chat; agent turns wait for the hand back.
    return new AgentGraphError(
      409,
      'The user is talking to this code agent directly; send again after they hand it back'
    );
  }
  return new AgentGraphError(
    502,
    `Code agent rejected the message (${delivery.reason ?? 'unknown'})`
  );
}

/**
 * Child-scoped chip row on the Rose agent that owns a code session, so the
 * code agent's own timeline shows the exchange. `subAgentId` keeps it out of
 * the owning agent's LLM context; there is no toolStatus because it is not a
 * lifecycle row of the spawn tool call.
 */
export async function recordCodeTimelineRow(args: {
  ownerAgentId: string;
  sessionId: string;
  provider: CodeProvider | null;
  toolCallId: string | null;
  key: string;
  title: string;
  text: string;
  a2a: Record<string, unknown>;
  direction: 'sent' | 'received';
  /** The CLI turn id this row was delivered as: the UI folds the session's own copy of it. */
  codeTurnId?: string;
}): Promise<void> {
  await createMessage({
    agentId: args.ownerAgentId,
    role: 'TOOL',
    text: args.text,
    metadata: {
      a2a: { ...args.a2a, direction: args.direction },
      idempotencyKey: `${args.key}:${args.direction}`,
      title: args.title,
      task_id: args.sessionId,
      subAgentId: args.sessionId,
      action_type: 'agent_message',
      ...(args.codeTurnId !== undefined ? { code_turn_id: args.codeTurnId } : {}),
      ...(args.provider !== null ? { code_provider: args.provider } : {}),
      ...(args.toolCallId !== null
        ? { toolCallId: args.toolCallId, toolName: 'spawn_claude_code_agent' }
        : {}),
    },
  });
}

/**
 * Code agent target: the CLI's next user turn. The ws-server dedupes by turn
 * id for the session's life, so a retry after a lost ack (or after the chip
 * write below failed) never starts a second CLI turn.
 */
export async function deliverToCodeAgent(args: {
  target: CodeTarget;
  key: string;
  text: string;
  title: string;
  a2a: Record<string, unknown>;
  original: string;
}): Promise<'delivered' | 'duplicate'> {
  const { target } = args;
  if (target.streamUrl === null || target.status !== 'ACTIVE') {
    throw new AgentGraphError(409, 'Code agent session is not running');
  }
  const turnId = codeTurnId(args.key);
  const delivery = await deliverUserTurnToCodeSession({
    wsUrl: target.streamUrl,
    taskId: target.id,
    turnId,
    text: args.text,
    sender: 'agent',
  });
  if (delivery.status !== 'delivered' && delivery.status !== 'duplicate') {
    throw deliveryError(delivery);
  }
  await recordCodeTimelineRow({
    ownerAgentId: target.ownerAgentId,
    sessionId: target.id,
    provider: target.provider,
    toolCallId: target.toolCallId,
    key: args.key,
    title: args.title,
    text: args.original,
    a2a: args.a2a,
    direction: 'received',
    codeTurnId: turnId,
  });
  return delivery.status;
}

/** A background task's inbox address (`<tool call id>` or `<tool call id>.run<n>`) → its tool call id. */
function taskToolCallId(taskAddress: string): string {
  return taskAddress.replace(/\.run\d+$/, '');
}

/**
 * A Rose agent's message to a RUNNING code background task (spawn_agent
 * type=code): nothing reads the owner's task inbox for a CLI, so the message
 * is the live CLI's next user turn, exactly like an agent-graph send to that
 * code session. Throws AgentGraphError (409 when no live CLI turn can take
 * it) so the sender learns the message was not delivered.
 */
export async function deliverToRunningCodeTask(args: {
  ownerAgentId: string;
  taskAddress: string;
  sender: { id: string; label: string };
  key: string;
  text: string;
}): Promise<{ message_id: string; status: 'delivered' | 'duplicate' }> {
  const session = await graphRepo.findCodeSessionForToolCall(
    args.ownerAgentId,
    taskToolCallId(args.taskAddress)
  );
  if (session === null) {
    throw new AgentGraphError(
      409,
      'Code agent session has not started yet; send again once it runs'
    );
  }
  const receivedId = deterministicMessageId(args.ownerAgentId, `${args.key}:received`);
  if ((await graphRepo.findMessageById(receivedId)) === null) {
    // Same per-sender cap as agent-graph sends; a retry of a delivered message is free.
    const budget = takeSendBudget(args.sender.id);
    if (!budget.ok) {
      throw new AgentGraphError(
        429,
        `Too many agent messages from this sender; retry in ${budget.retryAfterSeconds}s`,
        budget.retryAfterSeconds
      );
    }
  }
  const chip = await graphRepo.findCodeSessionChip(args.ownerAgentId, session.id);
  const target: CodeTarget = {
    kind: 'code',
    id: session.id,
    ownerAgentId: args.ownerAgentId,
    streamUrl: session.streamUrl,
    status: session.status,
    provider: chip.provider,
    toolCallId: chip.toolCallId,
  };
  const toLabel = codeLabel(target.provider);
  const a2a = {
    kind: 'message',
    message_id: args.key,
    from: { id: args.sender.id, kind: 'agent', label: args.sender.label },
    to: { id: target.id, kind: target.kind, label: toLabel },
    text: args.text,
  };
  const text = formatInboundAgentMessage({
    senderLabel: args.sender.label,
    senderId: args.sender.id,
    recipientKind: 'code',
    kind: 'message',
    text: args.text,
  });
  const status = await deliverToCodeAgent({
    target,
    key: args.key,
    text,
    title: `${args.sender.label} → ${toLabel}`,
    a2a,
    original: args.text,
  });
  return { message_id: receivedId, status };
}
