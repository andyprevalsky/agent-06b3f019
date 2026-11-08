/**
 * Undelivered code-session agent turns: a ws-server acked an agent turn
 * `queued` (the code agent was still starting, or the user held it in direct
 * chat) and ended before writing it to the CLI (`user_turn_undelivered`).
 *
 *   agents code-session monitor ─▶ POST /:owner/code-turns-undelivered
 *     ─▶ owner's received row (metadata.code_turn_id) ─▶ a2a.from
 *        ├─ a Rose agent ─▶ one notice in its inbox
 *        └─ a code agent ─▶ the notice as its CLI's next turn (if it still runs)
 *     (idempotent per received row: `${row.id}:undelivered`)
 *
 * 10k agents: one indexed lookup per lost turn on the owner's own rows; no
 * polling, nothing fans in.
 */
import { createLogger } from '../../providers/logger';
import * as graphRepo from './repoGraph';
import { deliverAgentGraphMessage } from './agentMessageService';
import { deliverToCodeAgent, type CodeTarget } from './agentCodeTurnDelivery';
import { AgentGraphError } from './agentGraphService';

const log = createLogger('AgentGraph');
const UNDELIVERED_TEXT_PREVIEW = 200;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What happened, truthfully: only `session_ended` means the session ended. */
function lossText(reason: string): string {
  return reason === 'session_ended'
    ? "the code agent's session ended before it read it"
    : `it could not be written to the code agent (${reason})`;
}

type Sender = { id: string; kind: 'agent' | 'code'; label: string };

function senderOf(from: Record<string, unknown> | null): Sender | null {
  if (from === null || typeof from.id !== 'string' || from.id === '') return null;
  if (from.kind !== 'agent' && from.kind !== 'code') return null;
  return {
    id: from.id,
    kind: from.kind,
    label: typeof from.label === 'string' ? from.label : 'Agent',
  };
}

/**
 * A code agent that sent the lost message gets the notice as its CLI's next
 * turn (the same path as any agent message to a code session). A sender whose
 * own session is no longer running cannot read anything: that is logged with
 * its reason and not counted.
 */
async function notifyCodeSender(
  sender: Sender,
  key: string,
  text: string,
  title: string,
  a2a: Record<string, unknown>
): Promise<boolean> {
  const session = await graphRepo.findGraphCodeSession(sender.id);
  if (session === null) {
    log.warn('Undelivered-turn notice: sender code session not found', { session_id: sender.id });
    return false;
  }
  const chip = await graphRepo.findCodeSessionChip(session.agentId, session.id);
  const target: CodeTarget = {
    kind: 'code',
    id: session.id,
    ownerAgentId: session.agentId,
    streamUrl: session.streamUrl,
    status: session.status,
    provider:
      session.codeProvider === 'claude' || session.codeProvider === 'codex'
        ? session.codeProvider
        : null,
    toolCallId: chip.toolCallId,
  };
  try {
    const status = await deliverToCodeAgent({ target, key, text, title, a2a, original: text });
    return status !== 'duplicate';
  } catch (error) {
    if (!(error instanceof AgentGraphError)) throw error;
    log.warn('Undelivered-turn notice could not reach the sending code agent', {
      session_id: sender.id,
      error: error.message,
    });
    return false;
  }
}

/**
 * A code session's ws-server accepted agent turns (`queued`: still starting, or
 * held for the user's direct chat) and never wrote them to the CLI (its
 * `user_turn_undelivered` event: the session ended, or the write failed). The
 * sender of each gets one truthful notice, keyed on the owner's received row
 * (server-side, target-scoped), so a `queued` promise is never silently broken:
 * a Rose agent in its inbox, a code agent as its CLI's next turn. Turn ids with
 * no received row are skipped.
 */
export async function reportUndeliveredCodeTurns(args: {
  ownerAgentId: string;
  sessionId: string;
  turnIds: string[];
  reason: string;
}): Promise<{ notified: number }> {
  let notified = 0;
  for (const turnId of new Set(args.turnIds)) {
    const row = await graphRepo.findCodeTurnRow(args.ownerAgentId, turnId);
    const a2a = recordOf(recordOf(row?.metadata)?.a2a);
    const sender = senderOf(recordOf(a2a?.from));
    // Only a lost agent message has a sender to tell. A lost notice (itself a
    // delivery-failure notification) is not reported back: that would bounce.
    if (row === null || a2a === null || sender === null || a2a.kind !== 'message') continue;
    const to = recordOf(a2a.to);
    const toLabel = typeof to?.label === 'string' ? to.label : 'the code agent';
    const original = typeof a2a.text === 'string' ? a2a.text : '';
    const preview =
      original.length > UNDELIVERED_TEXT_PREVIEW
        ? `${original.slice(0, UNDELIVERED_TEXT_PREVIEW)}…`
        : original;
    const key = `${row.id}:undelivered`;
    const resend =
      sender.kind === 'agent'
        ? 'resume the code agent with send_message_to_agent(continue_conversation=true) and send it again'
        : `send it again with rose-agents send ${args.sessionId}`;
    const text =
      `[Delivery failure from ${toLabel}, code session ${args.sessionId}]\n\n` +
      `Your message was not delivered: ${lossText(args.reason)}. Message: "${preview}". ` +
      `If it still matters, ${resend}.`;
    const title = `${toLabel} → ${sender.label}`;
    const notice = {
      kind: 'notification',
      message_id: key,
      from: { id: args.sessionId, kind: 'code', label: toLabel },
      to: { id: sender.id, kind: sender.kind, label: sender.label },
      text: `Not delivered (${args.reason}): ${preview}`,
    };
    const created =
      sender.kind === 'agent'
        ? (
            await deliverAgentGraphMessage(sender.id, {
              message: text,
              metadata: { a2a: notice, idempotencyKey: key, title },
            })
          ).created
        : await notifyCodeSender(sender, key, text, title, notice);
    if (created) notified += 1;
  }
  log.info('Reported undelivered code-session agent turns', {
    agent_id: args.ownerAgentId,
    session_id: args.sessionId,
    turns: String(args.turnIds.length),
    notified: String(notified),
    reason: args.reason,
  });
  return { notified };
}
