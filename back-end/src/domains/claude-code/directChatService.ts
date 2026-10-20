/**
 * Direct chat with a running code agent (Rose-builds-Rose C7).
 *
 *   FE query box (target = code session)
 *     │ POST /api/claude-code-session/:taskId/turns {client_message_id, text}
 *     ▼
 *   sendDirectTurn ── owner check (session.agentId → Agent.userId)
 *     │ already persisted? → return it (idempotent per client_message_id)
 *     ├─► deliverUserTurnToCodeSession ──ws──► sandbox ws-server ──► CLI stdin
 *     │        (ws-server dedupes by id, so a retry never repeats the turn)
 *     └─► createMessage(TOOL, action_type=user_direct_turn, deterministic id)
 *            → per-agent realtime INSERT on the owning agent's channel
 *
 * The CLI's output streams back over the session's own ws (FE live terminal
 * + the monitoring activity), so the exchange lands in the code agent's
 * trajectory and in the spawn tool's result the root agent reads. The row is
 * child-scoped (`subAgentId = taskId`) so it is not injected into the root
 * planner's context mid-run.
 *
 * 10k agents: one indexed session lookup, one agent lookup, one message
 * insert and one short-lived ws connection per typed turn; nothing fans in
 * across agents or users.
 */
import { createMessage } from '../../providers/messages';
import { createLogger } from '../../providers/logger';
import {
  deliverUserTurnToCodeSession,
  handBackCodeSession,
  type TurnDelivery,
} from '../../providers/codeSessionTurns';
import * as repo from './repo';

const log = createLogger('ClaudeCodeDirectChat');

export class DirectChatError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'DirectChatError';
  }
}

async function requireOwnedLiveSession(taskId: string, userId: string | undefined) {
  if (userId === undefined || userId === '') {
    throw new DirectChatError(
      400,
      'MISSING_USER_ID',
      'A user is required to chat with a code agent'
    );
  }
  const session = await repo.findSessionForDirectChat(taskId);
  // Not found and not yours look the same, so session ids cannot be probed.
  const agent = session === null ? null : await repo.findAgentById(session.agentId);
  if (session === null || agent === null || agent.userId !== userId) {
    throw new DirectChatError(404, 'CODE_SESSION_NOT_FOUND', 'Code session not found');
  }
  if (session.status !== 'ACTIVE' || session.streamUrl === null || session.streamUrl === '') {
    throw new DirectChatError(
      409,
      'CODE_SESSION_CLOSED',
      'This code session has finished. Ask Rose to continue the work.'
    );
  }
  return { ...session, streamUrl: session.streamUrl };
}

function deliveryError(delivery: TurnDelivery): DirectChatError {
  if (delivery.status === 'unreachable') {
    return new DirectChatError(502, 'CODE_SESSION_UNREACHABLE', 'Could not reach the code session');
  }
  switch (delivery.reason) {
    case 'session_ended':
      return new DirectChatError(
        409,
        'CODE_SESSION_CLOSED',
        'This code session has finished. Ask Rose to continue the work.'
      );
    case 'provider_unsupported':
      return new DirectChatError(
        409,
        'PROVIDER_UNSUPPORTED',
        'Direct chat is not available for this code agent yet'
      );
    default:
      return new DirectChatError(
        502,
        'CODE_SESSION_REJECTED',
        `The code session rejected the message (${delivery.reason ?? 'unknown'})`
      );
  }
}

export interface DirectTurnResult {
  status: 'delivered' | 'duplicate';
  message_id: string;
  task_id: string;
  agent_id: string;
}

export async function sendDirectTurn(params: {
  taskId: string;
  userId: string | undefined;
  clientMessageId: string;
  text: string;
  toolCallId?: string;
}): Promise<DirectTurnResult> {
  const { taskId, userId, clientMessageId, text } = params;
  const session = await requireOwnedLiveSession(taskId, userId);

  const metadata: Record<string, unknown> = {
    toolName: 'spawn_claude_code_agent',
    title: 'You',
    task_id: taskId,
    action_type: 'user_direct_turn',
    code_provider: 'claude',
    // Child-scoped like the chip's progress rows: visible in the code agent's
    // trajectory and tree grep, not replayed into the root planner mid-run.
    subAgentId: taskId,
    direct_turn_id: clientMessageId,
    isDirectCodeTurn: true,
    idempotencyKey: `code-turn:${taskId}:${clientMessageId}`,
    ...(params.toolCallId !== undefined ? { toolCallId: params.toolCallId } : {}),
  };

  const startedAt = Date.now();
  const delivery = await deliverUserTurnToCodeSession({
    wsUrl: session.streamUrl,
    taskId,
    turnId: clientMessageId,
    text,
    sender: 'user',
  });
  if (delivery.status !== 'delivered' && delivery.status !== 'duplicate') {
    log.warn('Direct turn not delivered', {
      taskId,
      clientMessageId,
      status: delivery.status,
      reason: delivery.reason,
    });
    throw deliveryError(delivery);
  }

  // Persist after the CLI has the turn: the trajectory never shows a message
  // the agent did not receive, and a retry re-persists idempotently.
  const message = await createMessage({
    agentId: session.agentId,
    role: 'TOOL',
    text,
    metadata,
  });
  log.info('Direct turn delivered', {
    taskId,
    agentId: session.agentId,
    clientMessageId,
    status: delivery.status,
    durationMs: String(Date.now() - startedAt),
  });
  return {
    status: delivery.status,
    message_id: message.id,
    task_id: taskId,
    agent_id: session.agentId,
  };
}

export async function handBackDirectChat(params: {
  taskId: string;
  userId: string | undefined;
}): Promise<{ status: 'released' | 'not_held' }> {
  const session = await requireOwnedLiveSession(params.taskId, params.userId);
  const status = await handBackCodeSession({ wsUrl: session.streamUrl, taskId: params.taskId });
  if (status === 'unreachable') {
    throw new DirectChatError(502, 'CODE_SESSION_UNREACHABLE', 'Could not reach the code session');
  }
  if (status === 'rejected') {
    throw new DirectChatError(
      502,
      'CODE_SESSION_REJECTED',
      'The code session rejected the hand back'
    );
  }
  return { status };
}
