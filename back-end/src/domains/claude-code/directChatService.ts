/**
 * Direct chat with a running code agent (Rose-builds-Rose C7).
 *
 *   FE "Message <agent> directly" box
 *     │ POST /api/agents/:id/code-agent/:taskId/messages {client_message_id, text}
 *     ▼
 *   sendDirectTurn ── owner check (session.agentId == :id, Agent.userId == caller)
 *     │ already persisted? → return it (idempotent per client_message_id)
 *     ├─► deliverUserTurnToCodeSession ──ws──► sandbox ws-server ──► CLI stdin
 *     │        (ws-server dedupes by id, so a retry never repeats the turn)
 *     └─► createMessage(TOOL, action_type=user_direct_turn, deterministic id)
 *            → per-agent realtime INSERT on the owning agent's channel
 *
 * A STOPPED code agent (its session paused, completed or failed) resumes
 * instead of refusing the turn (directChatResume.ts):
 *
 *   sendDirectTurn ── session not ACTIVE
 *     ├─ a later run of the same spawn is live → deliver there (above)
 *     └─ resumeStoppedCodeAgent → `queued`: the owner's wake (owner running,
 *        background task) or CodeAgentResumeWorkflow (owner finished/paused,
 *        foreground spawn); a turn sent while one starts queues behind it.
 *     The FE reads the resume progress from the next run's own rows
 *     (claude_code_started / a failure row), never from a timer.
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
  readCodeSessionCapabilities,
  type TurnDelivery,
  type CodeTurnSettings,
} from '../../providers/codeSessionTurns';
import * as repo from './repo';
import {
  DirectChatError,
  directTurnMetadata,
  liveRunOfSpawn,
  persistedTurnResult,
  restartStalledResume,
  type OwnedSession,
  type ResumeParams,
  liveSession,
  resumeStoppedCodeAgent,
  type DirectTurnResult,
  type LiveSession,
} from './directChatResume';
import {
  prepareDirectTurnAttachments,
  type DirectAttachment,
} from '../../providers/codeSessions/directTurnAttachments';

const log = createLogger('ClaudeCodeDirectChat');

export { DirectChatError, type DirectTurnResult };

async function requireOwnedSession(
  agentId: string | undefined,
  taskId: string,
  userId: string | undefined
) {
  if (userId === undefined || userId === '') {
    throw new DirectChatError(
      400,
      'MISSING_USER_ID',
      'A user is required to chat with a code agent'
    );
  }
  const session = await repo.findSessionForDirectChat(taskId);
  // Not found and not yours look the same, so session ids cannot be probed.
  const agent =
    session === null || (agentId !== undefined && session.agentId !== agentId)
      ? null
      : await repo.findLiveAgentById(session.agentId);
  if (session === null || agent === null || agent.userId !== userId) {
    throw new DirectChatError(404, 'CODE_SESSION_NOT_FOUND', 'Code session not found');
  }
  return session;
}

async function requireOwnedLiveSession(
  agentId: string | undefined,
  taskId: string,
  userId: string | undefined
): Promise<LiveSession> {
  const live = liveSession(await requireOwnedSession(agentId, taskId, userId));
  if (live === null) {
    throw new DirectChatError(
      409,
      'CODE_SESSION_CLOSED',
      'This code session has finished. Ask Rose to continue the work.'
    );
  }
  return live;
}

function deliveryError(delivery: TurnDelivery): DirectChatError {
  if (delivery.status === 'unreachable') {
    return new DirectChatError(502, 'CODE_SESSION_UNREACHABLE', 'Could not reach the code session');
  }
  switch (delivery.reason) {
    case 'unsupported_settings':
    case 'unsupported_while_active':
    case 'settings_rejected':
      return new DirectChatError(
        409,
        'UNSUPPORTED_SETTINGS',
        'The code session cannot apply those settings. Refresh its available settings and retry.'
      );
    case 'settings_unconfirmed':
      return new DirectChatError(
        502,
        'SETTINGS_UNCONFIRMED',
        'Could not confirm settings; your message was not sent.'
      );
    case 'session_ended':
      return new DirectChatError(
        409,
        'CODE_SESSION_CLOSED',
        'This code session has finished. Ask Rose to continue the work.'
      );
    case 'session_starting':
      return new DirectChatError(
        409,
        'CODE_SESSION_STARTING',
        'The code agent is still starting. Send your message again in a moment.'
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

/** The turn's attachments staged for the CLI, or the user-facing refusal. */
function directTurnAttachments(attachments: DirectAttachment[] | undefined, userId?: string) {
  return prepareDirectTurnAttachments(attachments, userId ?? '').catch((error: unknown) => {
    if (
      error instanceof Error &&
      ['INVALID_ATTACHMENT', 'ATTACHMENTS_TOO_LARGE'].includes(error.message)
    ) {
      throw new DirectChatError(400, error.message, 'Could not accept these attachments');
    }
    throw new DirectChatError(
      502,
      'ATTACHMENTS_UNAVAILABLE',
      'Could not load attachments; your message was not sent'
    );
  });
}

/** The spawn tool call is the chip's (server-side): a client-sent value may only match it. */
function spawnToolCallId(chip: string | null, sent: string | undefined): string | undefined {
  if (sent !== undefined && sent !== chip) {
    throw new DirectChatError(400, 'INVALID_TOOL_CALL', 'This turn names another code agent');
  }
  return chip ?? undefined;
}

/**
 * The session a turn addresses, its chip (CLI + spawn tool call) and, for a
 * resend of an already persisted turn, that turn's result.
 */
async function turnTarget(params: {
  agentId?: string;
  taskId: string;
  userId: string | undefined;
  clientMessageId: string;
  toolCallId?: string;
}) {
  const owned = await requireOwnedSession(params.agentId, params.taskId, params.userId);
  // The chip row names the CLI (Claude Code or Codex share this table) and the
  // spawn tool call the UI groups the code agent's rows under.
  const chip = await repo.findCodeSessionChip(owned.agentId, params.taskId);
  const toolCallId = spawnToolCallId(chip.toolCallId, params.toolCallId);
  const find = repo.findDirectTurnRow;
  const resent = await persistedTurnResult(
    owned,
    chip.provider,
    toolCallId,
    params.clientMessageId,
    find
  );
  return { owned, chip, toolCallId, resent };
}

/** A resend: the persisted turn's result; a resume that never started is started again. */
async function finishResend(
  params: Omit<ResumeParams, 'session' | 'toolCallId' | 'provider' | 'userId'> & {
    userId: string | undefined;
  },
  owned: OwnedSession,
  provider: 'claude' | 'codex',
  toolCallId: string | undefined,
  resent: { result: DirectTurnResult; at: Date }
): Promise<DirectTurnResult> {
  if (resent.result.resuming === true) {
    const resume = { ...params, session: owned, toolCallId, provider, userId: params.userId ?? '' };
    await restartStalledResume(resume, resent.at).catch((error: unknown) => {
      log.warn('Restarting a stalled code agent resume failed', {
        taskId: owned.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return resent.result;
}

export async function sendDirectTurn(params: {
  /** From `/api/agents/:id/code-agent/...`; absent on the claude-code-session route. */
  agentId?: string;
  taskId: string;
  userId: string | undefined;
  clientMessageId: string;
  text: string;
  attachments?: DirectAttachment[];
  settings?: CodeTurnSettings;
  toolCallId?: string;
}): Promise<DirectTurnResult> {
  const { userId, clientMessageId, text } = params;
  const { owned, chip, toolCallId, resent } = await turnTarget(params);
  if (resent !== null) return finishResend(params, owned, chip.provider, toolCallId, resent);
  let session = liveSession(owned) ?? (await liveRunOfSpawn(owned, toolCallId));
  if (session === null) {
    const resumed = await resumeStoppedCodeAgent({
      ...params,
      session: owned,
      toolCallId,
      provider: chip.provider,
      userId: userId ?? '',
    });
    if (!('live' in resumed)) return resumed;
    session = resumed.live;
  }
  const taskId = session.id;
  const metadata = directTurnMetadata(taskId, clientMessageId, chip.provider, toolCallId);
  const attachments = await directTurnAttachments(params.attachments, userId);
  const startedAt = Date.now();
  const delivery = await deliverUserTurnToCodeSession({
    wsUrl: session.streamUrl,
    taskId,
    turnId: clientMessageId,
    text,
    sender: 'user',
    attachments,
    settings: params.settings,
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
    metadata: {
      ...metadata,
      ...((params.attachments?.length ?? 0) > 0 ? { attachments: params.attachments } : {}),
      effective_settings: delivery.effective_settings,
      turn_id: delivery.turn_id,
      delivery_mode: delivery.delivery_mode,
    },
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
    code_provider: chip.provider,
    ...(delivery.effective_settings ? { effective_settings: delivery.effective_settings } : {}),
    ...(delivery.delivery_mode ? { delivery_mode: delivery.delivery_mode } : {}),
    ...(delivery.turn_id !== undefined ? { turn_id: delivery.turn_id } : {}),
  };
}

export async function handBackDirectChat(params: {
  agentId?: string;
  taskId: string;
  userId: string | undefined;
}): Promise<{ status: 'released' | 'not_held' }> {
  const session = await requireOwnedLiveSession(params.agentId, params.taskId, params.userId);
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

export async function getDirectChatCapabilities(params: {
  taskId: string;
  userId: string | undefined;
}) {
  const session = await requireOwnedLiveSession(undefined, params.taskId, params.userId);
  try {
    const capabilities = await readCodeSessionCapabilities({
      wsUrl: session.streamUrl,
      taskId: params.taskId,
    });
    if (capabilities.status !== 'delivered')
      throw new Error(capabilities.reason ?? 'Capabilities unavailable');
    return {
      code_provider: capabilities.code_provider,
      effective_settings: capabilities.effective_settings,
      models: capabilities.models ?? [],
    };
  } catch {
    throw new DirectChatError(
      502,
      'CAPABILITIES_UNAVAILABLE',
      'Could not confirm code session capabilities'
    );
  }
}
