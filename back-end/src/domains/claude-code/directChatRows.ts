/**
 * Shared shapes of the code-agent direct chat (directChatService.ts) and the
 * resume of a stopped code agent (directChatResume.ts): the error type, the
 * session views, the person's turn row (`user_direct_turn`, with
 * `resume_requested` while it resumes the agent), the UI-only failure row and
 * the turn's CLI settings as a create override.
 */
import { createMessage } from '../../providers/messages';
import { idempotentMessageId } from '../../providers/messageIdempotency';
import { createLogger } from '../../providers/logger';
import type { CodeTurnSettings } from '../../providers/codeSessionTurns';
import type { CodeCliSettingsOverride } from '../../providers/codeAgentModels';
import type { DirectAttachment } from '../../providers/codeSessions/directTurnAttachments';

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

export interface OwnedSession {
  id: string;
  agentId: string;
  status: string;
  streamUrl: string | null;
  codeSessionId?: string | null;
  taskName?: string | null;
}
export type LiveSession = OwnedSession & { streamUrl: string };

export function liveSession(session: OwnedSession): LiveSession | null {
  if (session.status !== 'ACTIVE' || session.streamUrl === null || session.streamUrl === '') {
    return null;
  }
  return { ...session, streamUrl: session.streamUrl };
}

export interface DirectTurnResult {
  /** `queued`: the code agent was stopped; it is resuming and this is its next turn. */
  status: 'delivered' | 'duplicate' | 'queued';
  resuming?: true;
  message_id: string;
  task_id: string;
  agent_id: string;
  code_provider: 'claude' | 'codex';
  effective_settings?: CodeTurnSettings;
  delivery_mode?: 'steer' | 'start';
  turn_id?: string;
}

export interface ResumeParams {
  session: OwnedSession;
  toolCallId: string | undefined;
  provider: 'claude' | 'codex';
  userId: string;
  clientMessageId: string;
  text: string;
  attachments?: DirectAttachment[];
  settings?: CodeTurnSettings;
}

export function resumeRow(params: ResumeParams, toolCallId: string) {
  const { session, clientMessageId, provider, attachments } = params;
  return {
    agentId: session.agentId,
    role: 'TOOL' as const,
    text: params.text,
    metadata: {
      ...directTurnMetadata(session.id, clientMessageId, provider, toolCallId),
      resume_requested: true,
      ...((attachments?.length ?? 0) > 0 ? { attachments } : {}),
    },
  };
}

export async function persistQueued(
  params: ResumeParams,
  toolCallId: string
): Promise<DirectTurnResult> {
  const message = await createMessage(resumeRow(params, toolCallId));
  return {
    status: 'queued',
    resuming: true,
    message_id: message.id,
    task_id: params.session.id,
    agent_id: params.session.agentId,
    code_provider: params.provider,
  };
}

/** The typed turn's model / effort / speed as the resumed session's create settings. */
export function cliSettingsOf(
  settings: CodeTurnSettings | undefined
): CodeCliSettingsOverride | null {
  const set = (value: string | undefined): value is string => value !== undefined && value !== '';
  if (settings === undefined) return null;
  const { model, effort, speed } = settings;
  if (!set(model) && !set(effort) && !set(speed)) return null;
  return {
    ...(set(model) ? { model } : {}),
    ...(set(effort) ? { reasoning_effort: effort } : {}),
    ...(set(speed) ? { speed } : {}),
  };
}

/** The resume could not start: the turn reads "Couldn't resume: <reason>" (UI-only row). */
export async function postResumeFailure(
  agentId: string,
  toolCallId: string,
  error: unknown
): Promise<void> {
  const reason = error instanceof Error ? error.message : 'the code agent could not be started';
  await createMessage({
    agentId,
    role: 'TOOL',
    text: reason,
    metadata: {
      toolName: 'spawn_claude_code_agent',
      toolCallId,
      toolStatus: 'ERROR',
      title: 'Code agent could not resume',
      excludeFromModel: true,
      codeAgentResume: 'failed',
    },
  }).catch((postError: unknown) => {
    log.error('Could not record a failed code agent resume', {
      agentId,
      toolCallId,
      error: postError instanceof Error ? postError.message : String(postError),
    });
  });
}

export function directTurnMetadata(
  taskId: string,
  clientMessageId: string,
  provider: string,
  toolCallId: string | undefined
): Record<string, unknown> {
  return {
    toolName: 'spawn_claude_code_agent',
    title: 'You',
    task_id: taskId,
    action_type: 'user_direct_turn',
    code_provider: provider,
    // Child-scoped like the chip's progress rows: visible in the code agent's
    // trajectory and tree grep, not replayed into the root planner mid-run.
    subAgentId: taskId,
    direct_turn_id: clientMessageId,
    isDirectCodeTurn: true,
    idempotencyKey: `code-turn:${taskId}:${clientMessageId}`,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
  };
}

/**
 * The turn already persisted under this client_message_id (a resend): its
 * result again, with nothing delivered, queued or started a second time.
 */
export async function persistedTurnResult(
  session: OwnedSession,
  provider: 'claude' | 'codex',
  toolCallId: string | undefined,
  clientMessageId: string,
  find: (id: string) => Promise<{ id: string; metadata: unknown; timestamp: Date } | null>
): Promise<{ result: DirectTurnResult; at: Date } | null> {
  const id = idempotentMessageId({
    agentId: session.agentId,
    role: 'TOOL',
    metadata: directTurnMetadata(session.id, clientMessageId, provider, toolCallId),
  });
  const row = id === null ? null : await find(id);
  if (row === null) return null;
  const resuming = (row.metadata as Record<string, unknown> | null)?.resume_requested === true;
  return {
    at: row.timestamp,
    result: {
      status: resuming ? 'queued' : 'duplicate',
      ...(resuming ? { resuming: true as const } : {}),
      message_id: row.id,
      task_id: session.id,
      agent_id: session.agentId,
      code_provider: provider,
    },
  };
}
