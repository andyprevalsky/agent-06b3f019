/**
 * The code session as the flat main-chat message list the code-agent view renders
 * (buildCodeSession's turn slots dissolved, one row per model call). See
 * CodeAgentContext.tsx.
 */

import type { Message } from '@/lib/api/types';

import { buildCodeSession, type CodeSessionInput } from './codeSessionTurns';

/**
 * The code session as ONE ordered main-chat message list, the shape the root
 * transcript renders: the turn slots dissolve into their activity rows, so the
 * root's work grouping (groupTrajectoryWork) folds them into "Worked for …"
 * between the user-facing rows exactly as it does for a Rose agent. A slot with
 * no activity contributes nothing (never an empty "Worked for" row).
 */
export function codeSessionMessages(input: CodeSessionInput): Message[] {
  return oneRowPerCall(
    buildCodeSession(input)
      .flatMap((entry) => (entry.kind === 'work' ? entry.turn.activities : [entry.message]))
      .map(verbatim),
  );
}

/** A thought-like row: a thinking record (thought tool row) or mid-turn narration (assistant text). */
function isThoughtRow(message: Message): boolean {
  return (
    message.role === 'ASSISTANT' ||
    (message.role === 'TOOL' && message.metadata?.toolName === 'thought')
  );
}

/** The model call a thought-like row belongs to: its recorded generation window. */
function callWindow(message: Message): string | null {
  const generation = message.metadata?.generation as
    { output_tokens?: number; started_at?: string; ended_at?: string } | undefined;
  if (!generation || !isThoughtRow(message)) return null;
  return `${generation.started_at}|${generation.ended_at}|${generation.output_tokens}`;
}

/**
 * One model call = ONE Thought row. A call's thinking record and its narration text each
 * carry the call's generation, so rendered separately they read as a duplicated row with
 * the same metrics. Adjacent thought-like rows of the same call merge into the first one's
 * row (its id, position and metrics, once); its content holds the reasoning, then the
 * narration. A call with only narration keeps its one row.
 */
function oneRowPerCall(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const key = callWindow(message);
    const previous = out.at(-1);
    if (key === null || previous === undefined || callWindow(previous) !== key) {
      out.push(message);
      continue;
    }
    // The thinking record (thought tool row) is the call's row; narration only adds text.
    const tool = previous.role === 'TOOL' ? previous : message.role === 'TOOL' ? message : null;
    const base = tool ?? previous;
    const texts = [tool?.text, ...[previous, message].filter((m) => m !== tool).map((m) => m.text)];
    const text = [...new Set(texts.map((value) => (value ?? '').trim()).filter(Boolean))].join(
      '\n\n',
    );
    out[out.length - 1] = {
      ...base,
      message_id: previous.message_id,
      timestamp: previous.timestamp,
      text,
    };
  }
  return out;
}

/**
 * A code agent's text is its own output on the user's repo (a grep, a file, its
 * thinking), never Rose's plumbing copy: the trajectory's Fast Mode / DEMO-cache
 * scrub (userFacingMessageText) must not blank "FastModeToggle" out of it.
 */
function verbatim(message: Message): Message {
  if (message.role === 'USER' || message.role === 'SYSTEM') return message;
  return { ...message, metadata: { ...message.metadata, verbatimText: true } };
}
