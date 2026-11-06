/**
 * What an agent-to-code-agent message looks like in the code agent's own
 * timeline, and the CLI turn id it is delivered as. Shared by the agents
 * domain (a send to a session that is up) and the startup queue (a send that
 * arrived before the session existed), so both write the same rows.
 */
import { createHash } from 'node:crypto';
import { createMessage } from '../messages';

export type CodeAgentProvider = 'claude' | 'codex';

const PROVIDER_LABEL: Record<CodeAgentProvider, string> = { claude: 'Claude Code', codex: 'Codex' };

export function codeLabel(provider: CodeAgentProvider | null): string {
  return provider === null ? 'Code agent' : PROVIDER_LABEL[provider];
}

/** ws-server turn ids are bounded; derive a stable short id from the key. */
export function codeTurnId(key: string): string {
  return `a2a-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** Title and `a2a` metadata of one agent message to a code session. */
export function agentMessageRowFields(args: {
  key: string;
  sender: { id: string; label: string };
  session: { id: string; provider: CodeAgentProvider | null };
  original: string;
}): { title: string; a2a: Record<string, unknown> } {
  const toLabel = codeLabel(args.session.provider);
  return {
    title: `${args.sender.label} → ${toLabel}`,
    a2a: {
      kind: 'message',
      message_id: args.key,
      from: { id: args.sender.id, kind: 'agent', label: args.sender.label },
      to: { id: args.session.id, kind: 'code', label: toLabel },
      text: args.original,
    },
  };
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
  provider: CodeAgentProvider | null;
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
