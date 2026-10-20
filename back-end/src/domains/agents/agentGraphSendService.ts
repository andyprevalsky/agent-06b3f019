/**
 * Agent graph send: one A2A message from a Rose agent or a code agent to any
 * agent / code agent of the same tree (scope rules in agentGraphService).
 *
 *   Rose agent target → idempotent USER message (normal postMessage path)
 *   code agent target → deliverUserTurnToCodeSession (sender "agent"): the
 *                       CLI's next user turn, delivered once per message id
 *   code agent sender/target → child-scoped chip rows, so the code agent's
 *                       own timeline shows "<sender> → Codex" / "Codex → <target>"
 */
import { createHash } from 'node:crypto';
import { createMessage } from '../../providers/messages';
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { deliverUserTurnToCodeSession, type TurnDelivery } from '../../providers/codeSessionTurns';
import { createLogger } from '../../providers/logger';
import * as messageService from './agentMessageService';
import * as graphRepo from './repoGraph';
import {
  AgentGraphError,
  NOT_FOUND,
  inCallerTree,
  resolveAlias,
  type CodeProvider,
  type GraphCaller,
} from './agentGraphService';

const log = createLogger('AgentGraph');

export type GraphMessageKind = 'message' | 'question';

export interface SendInput {
  to: string;
  text: string;
  message_id: string;
}

export interface SendResult {
  message_id: string;
  status: 'delivered' | 'duplicate';
  to: { id: string; kind: 'agent' | 'code' };
}

type Target =
  | { kind: 'agent'; id: string; title: string | null; isRoot: boolean }
  | {
      kind: 'code';
      id: string;
      ownerAgentId: string;
      streamUrl: string | null;
      status: string;
      provider: CodeProvider | null;
      toolCallId: string | null;
    };

const PROVIDER_LABEL: Record<CodeProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

function codeLabel(provider: CodeProvider | null): string {
  return provider === null ? 'Code agent' : PROVIDER_LABEL[provider];
}

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

/**
 * LLM-visible framing of an inbound agent message (prompt-scoped text): who
 * sent it and how to answer from the recipient's own tool surface.
 */
export function formatInboundAgentMessage(args: {
  senderLabel: string;
  senderId: string;
  recipientKind: 'agent' | 'code';
  kind: GraphMessageKind;
  text: string;
}): string {
  const what = args.kind === 'question' ? 'Question' : 'Message';
  const reply =
    args.recipientKind === 'code'
      ? `Reply with: rose-agents send ${args.senderId} "<message>"`
      : args.kind === 'question'
        ? 'Answer with send_message_to_agent; if you cannot, ask your parent the same way (agent_id "parent")'
        : 'Reply with send_message_to_agent if a reply is needed';
  return `[${what} from ${args.senderLabel}, agent_id ${args.senderId}. ${reply}]\n\n${args.text}`;
}

/** ws-server turn ids are bounded; derive a stable short id from the key. */
function codeTurnId(key: string): string {
  return `a2a-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

async function resolveTarget(caller: GraphCaller, to: string): Promise<Target> {
  const agent = await graphRepo.findGraphAgent(to);
  if (agent !== null) {
    if (agent.userId !== caller.userId || !(await inCallerTree(caller, agent.id))) {
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
  if (session !== null && (await inCallerTree(caller, session.agentId))) {
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
async function recordCodeTimelineRow(args: {
  ownerAgentId: string;
  sessionId: string;
  provider: CodeProvider | null;
  toolCallId: string | null;
  key: string;
  title: string;
  text: string;
  a2a: Record<string, unknown>;
  direction: 'sent' | 'received';
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
      ...(args.provider !== null ? { code_provider: args.provider } : {}),
      ...(args.toolCallId !== null
        ? { toolCallId: args.toolCallId, toolName: 'spawn_claude_code_agent' }
        : {}),
    },
  });
}

type AgentTarget = Extract<Target, { kind: 'agent' }>;
type CodeTarget = Extract<Target, { kind: 'code' }>;

/** Rose agent target: one USER row keyed by (target, sender key). */
async function deliverToRoseAgent(args: {
  caller: GraphCaller;
  target: AgentTarget;
  key: string;
  text: string;
  title: string;
  a2a: Record<string, unknown>;
}): Promise<SendResult['status']> {
  const existing = await graphRepo.findMessageById(
    deterministicMessageId(args.target.id, args.key)
  );
  if (existing !== null) return 'duplicate';
  const posted = await messageService.postMessage(
    args.target.id,
    {
      message: args.text,
      role: 'USER',
      metadata: { a2a: args.a2a, idempotencyKey: args.key, title: args.title },
    },
    false,
    args.caller.userId
  );
  if ('error' in posted) throw new AgentGraphError(posted.status ?? 500, posted.error);
  return 'delivered';
}

/**
 * Code agent target: the CLI's next user turn. The ws-server dedupes by turn
 * id for the session's life, so a retry after a lost ack (or after the chip
 * write below failed) never starts a second CLI turn.
 */
async function deliverToCodeAgent(args: {
  target: CodeTarget;
  key: string;
  text: string;
  title: string;
  a2a: Record<string, unknown>;
  original: string;
}): Promise<SendResult['status']> {
  const { target } = args;
  if (target.streamUrl === null || target.status !== 'ACTIVE') {
    throw new AgentGraphError(409, 'Code agent session is not running');
  }
  const delivery = await deliverUserTurnToCodeSession({
    wsUrl: target.streamUrl,
    taskId: target.id,
    turnId: codeTurnId(args.key),
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
  });
  return delivery.status;
}

export async function sendGraphMessage(
  caller: GraphCaller,
  input: SendInput,
  kind: GraphMessageKind = 'message'
): Promise<SendResult> {
  const to = await resolveAlias(caller, input.to);
  if (to === caller.self.id) throw new AgentGraphError(400, 'Cannot message yourself');
  const target = await resolveTarget(caller, to);
  // Keyed by sender so two agents can never collide on a client-chosen id.
  const key = `a2a:${caller.self.id}:${input.message_id}`;
  const fromLabel = selfLabel(caller);
  const toLabel = targetLabel(target);
  const a2a = {
    kind,
    message_id: input.message_id,
    from: { ...senderMetadata(caller), label: fromLabel },
    to: { id: target.id, kind: target.kind, label: toLabel },
  };
  const text = formatInboundAgentMessage({
    senderLabel: fromLabel,
    senderId: caller.self.id,
    recipientKind: target.kind,
    kind,
    text: input.text,
  });

  const title = `${fromLabel} → ${toLabel}`;
  const status =
    target.kind === 'agent'
      ? await deliverToRoseAgent({ caller, target, key, text, title, a2a })
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
