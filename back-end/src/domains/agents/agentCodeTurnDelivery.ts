/**
 * Code agent turns: a message to a code session is the live CLI's next user
 * turn (ws-server user_turn protocol, sender "agent"), delivered once per
 * message id, plus a child-scoped chip row on the session's owner.
 *
 *   agent-graph send to a code session ─┐
 *   send_message_to_agent to a RUNNING  ├─▶ deliverToCodeAgent ─▶ CLI turn
 *   code background task ───────────────┘    (deliverToRunningCodeTask)
 *
 * A message that arrives before the code agent's CLI runs is accepted, not
 * refused: while the spawn's create is in flight it waits in the spawn's
 * startup row (providers/codeSessions/startupTurns.ts); once the ws-server is
 * up but the CLI has not been given its task, the ws-server holds it. Either
 * way it becomes the CLI's next turn right after the task prompt, in arrival
 * order, and the sender is told `queued`. A session that finished or closed
 * is never "queued": that stays the truthful error.
 *
 * No question path: code agents only receive messages here.
 */
import { deterministicMessageId } from '../../providers/messageIdempotency';
import { deliverUserTurnToCodeSession, type TurnDelivery } from '../../providers/codeSessionTurns';
import {
  agentMessageRowFields,
  codeTurnId,
  recordCodeTimelineRow,
} from '../../providers/codeSessions/agentMessageRows';
import {
  enqueueStartupTurn,
  publishedStartupTask,
  startupTurnsKey,
} from '../../providers/codeSessions/startupTurns';
import { formatInboundAgentMessage } from './agentGraphMessageFormat';
import { takeSendBudget } from '../../providers/agentGraph/sendBudget';
import { createLogger } from '../../providers/logger';
import * as graphRepo from './repoGraph';
import { AgentGraphError, type CodeProvider } from './agentGraphService';

const log = createLogger('AgentGraph');

export interface CodeTarget {
  kind: 'code';
  id: string;
  ownerAgentId: string;
  streamUrl: string | null;
  status: string;
  provider: CodeProvider | null;
  toolCallId: string | null;
}

function deliveryError(delivery: TurnDelivery, endedMessage?: string): AgentGraphError {
  if (delivery.status === 'unreachable') {
    return new AgentGraphError(502, 'Could not reach the code agent session');
  }
  if (delivery.reason === 'session_ended') {
    return new AgentGraphError(409, endedMessage ?? 'Code agent session has finished');
  }
  if (delivery.reason === 'relay_paused') {
    // The user holds the session in direct chat; agent turns wait for the hand back.
    return new AgentGraphError(
      409,
      'The user is talking to this code agent directly; send again after they hand it back'
    );
  }
  if (delivery.reason === 'startup_queue_full') return new AgentGraphError(409, STARTUP_QUEUE_FULL);
  if (delivery.reason === 'session_starting') {
    return new AgentGraphError(409, 'Code agent is still starting; send again once it runs');
  }
  return new AgentGraphError(
    502,
    `Code agent rejected the message (${delivery.reason ?? 'unknown'})`
  );
}

/** The 409 text when a code agent that is still starting cannot hold another message. */
const STARTUP_QUEUE_FULL =
  'Code agent is still starting and its queue of waiting messages is full; send again once it runs';

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
  /** The 409 text when the CLI turn already ended (defaults to "has finished"). */
  endedMessage?: string;
}): Promise<'delivered' | 'duplicate' | 'queued'> {
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
  if (
    delivery.status !== 'delivered' &&
    delivery.status !== 'duplicate' &&
    delivery.status !== 'queued'
  ) {
    throw deliveryError(delivery, args.endedMessage);
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

/** The session of this run of the spawn, once it exists (published by its create, or announced by its rows). */
async function findStartedCodeSession(
  ownerAgentId: string,
  toolCallId: string,
  since: Date | null,
  publishedTaskId: string | null
): Promise<graphRepo.GraphCodeSessionRow | null> {
  if (publishedTaskId !== null) {
    // An earlier run's session (woken tasks keep their tool call id) predates `since`.
    const published = await graphRepo.findGraphCodeSession(publishedTaskId);
    if (
      published !== null &&
      published.agentId === ownerAgentId &&
      (since === null || published.createdAt >= since)
    ) {
      return published;
    }
  }
  return graphRepo.findCodeSessionForToolCall(ownerAgentId, toolCallId, since);
}

/**
 * The agent-graph per-sender send budget, taken at most once for one message:
 * a retry of a delivered message (its received row exists) is free.
 */
function sendBudgetOnce(senderId: string, receivedId: string): () => Promise<void> {
  let taken = false;
  return async () => {
    if (taken) return;
    taken = true;
    if ((await graphRepo.findMessageById(receivedId)) !== null) return;
    const budget = takeSendBudget(senderId);
    if (!budget.ok) {
      throw new AgentGraphError(
        429,
        `Too many agent messages from this sender; retry in ${budget.retryAfterSeconds}s`,
        budget.retryAfterSeconds
      );
    }
  };
}

function codeTargetOf(
  session: graphRepo.GraphCodeSessionRow,
  ownerAgentId: string,
  toolCallId: string
): CodeTarget {
  return {
    kind: 'code',
    id: session.id,
    ownerAgentId,
    streamUrl: session.streamUrl,
    status: session.status,
    provider:
      session.codeProvider === 'claude' || session.codeProvider === 'codex'
        ? session.codeProvider
        : null,
    toolCallId,
  };
}

/**
 * A Rose agent's message to a RUNNING code background task (spawn_agent
 * type=code): nothing reads the owner's task inbox for a CLI, so the message
 * is the live CLI's next user turn, exactly like an agent-graph send to that
 * code session. A task whose session does not exist yet (its create is still
 * running) takes the message into its startup row: `queued`. Throws
 * AgentGraphError (409 when no live CLI turn can take it) so the sender
 * learns the message was not delivered.
 */
export async function deliverToRunningCodeTask(args: {
  ownerAgentId: string;
  taskAddress: string;
  /** When the task's current run started (tree state): older sessions belong to earlier runs. */
  runStartedAt: Date | null;
  sender: { id: string; label: string };
  key: string;
  text: string;
}): Promise<{ message_id: string; status: 'delivered' | 'duplicate' | 'queued' }> {
  const toolCallId = taskToolCallId(args.taskAddress);
  const spawnKey = startupTurnsKey(args.ownerAgentId, toolCallId);
  const receivedId = deterministicMessageId(args.ownerAgentId, `${args.key}:received`);
  const text = formatInboundAgentMessage({
    senderLabel: args.sender.label,
    senderId: args.sender.id,
    recipientKind: 'code',
    kind: 'message',
    text: args.text,
  });
  const takeBudget = sendBudgetOnce(args.sender.id, receivedId);
  const findStarted = (publishedTaskId: string | null) =>
    findStartedCodeSession(args.ownerAgentId, toolCallId, args.runStartedAt, publishedTaskId);
  let session = await findStarted(await publishedStartupTask(spawnKey));
  if (session === null) {
    const outcome = await enqueueStartupTurn(
      spawnKey,
      { key: args.key, text, original: args.text, sender: args.sender, toolCallId },
      { findStarted, admit: takeBudget }
    );
    if (outcome.status === 'full') throw new AgentGraphError(409, STARTUP_QUEUE_FULL);
    if (outcome.status === 'queued') {
      log.info('Agent message queued for a code task that has not started', {
        agent_id: args.ownerAgentId,
        from_agent_id: args.sender.id,
        recipient_task_id: args.taskAddress,
        position: outcome.position,
      });
      return { message_id: receivedId, status: 'queued' };
    }
    session = outcome.session;
  }
  await takeBudget();
  const target = codeTargetOf(session, args.ownerAgentId, toolCallId);
  const { title, a2a } = agentMessageRowFields({
    key: args.key,
    sender: args.sender,
    session: { id: target.id, provider: target.provider },
    original: args.text,
  });
  const status = await deliverToCodeAgent({
    target,
    key: args.key,
    text,
    title,
    a2a,
    original: args.text,
    endedMessage:
      'Code agent session has finished its turn, so this message was not delivered. Wait for its ' +
      'notification: resume a paused code agent with send_message_to_agent(continue_conversation=true); ' +
      'for new work after it completed, spawn a new code agent.',
  });
  return { message_id: receivedId, status };
}

/**
 * POST /:id/agent-messages to a running code task (agentToAgentService):
 * the turn, or the refusal as the route's { error, status }.
 */
export async function sendAgentMessageToRunningCodeTask(args: {
  ownerAgentId: string;
  taskAddress: string;
  runStartedAt: string | null;
  sender: { id: string; label: string };
  idempotencyKey: string;
  text: string;
}): Promise<
  | { message_id: string; delivered: boolean; queued?: true; task_running: true }
  | { error: string; status: number }
> {
  const started = args.runStartedAt !== null ? new Date(args.runStartedAt) : null;
  try {
    const delivered = await deliverToRunningCodeTask({
      ownerAgentId: args.ownerAgentId,
      taskAddress: args.taskAddress,
      runStartedAt: started !== null && !Number.isNaN(started.getTime()) ? started : null,
      sender: args.sender,
      key: `a2a:${args.sender.id}:${args.idempotencyKey}`,
      text: args.text,
    });
    log.info('Agent message delivered to a running code task', {
      agent_id: args.ownerAgentId,
      from_agent_id: args.sender.id,
      recipient_task_id: args.taskAddress,
      status: delivered.status,
    });
    // `queued`: accepted for a code agent still starting; it is its next turn once the CLI runs.
    return delivered.status === 'queued'
      ? { message_id: delivered.message_id, delivered: false, queued: true, task_running: true }
      : { message_id: delivered.message_id, delivered: true, task_running: true };
  } catch (error) {
    if (error instanceof AgentGraphError) return { error: error.message, status: error.status };
    throw error;
  }
}
