/**
 * Session-local steering state shared by the code-agent chip and the pinned
 * question (they mount in different subtrees: trajectory vs. above the query box).
 *
 * STATE MACHINE (per task / question, in memory, this tab only):
 *   echoes:    [] → (user steers or answers) → [{ text, at }] → shown as "You → <agent>"
 *              until the session echoes the same text back as a user transcript event
 *   questions: [PINNED] → answered | dismissed (hidden for the rest of the session)
 *
 * Keyed by task id / question id, bounded per task, never shared across agents.
 */

import type { CodeTurnOptions } from './codeAgentContract';
import { useSyncExternalStore } from 'react';

export interface LocalEcho {
  text: string;
  at: number;
  /** The direct turn's client_message_id (the session echoes it back as turn_id). */
  id?: string;
}

export const pendingCodeTurns = new Map<string, { payload: string; id: string }>();
const drafts = new Map<string, { text: string; options: CodeTurnOptions }>();
export const getCodeDraft = (taskId: string) => drafts.get(taskId);
export const setCodeDraft = (taskId: string, draft: { text: string; options: CodeTurnOptions }) => {
  drafts.set(taskId, draft);
};

const MAX_ECHOES_PER_TASK = 50;
const EMPTY: readonly LocalEcho[] = [];

let echoesByTask = new Map<string, readonly LocalEcho[]>();
let closedQuestions = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addLocalEcho(taskId: string, text: string, at: number = Date.now(), id?: string) {
  const next = [...(echoesByTask.get(taskId) ?? EMPTY), { text, at, id }].slice(
    -MAX_ECHOES_PER_TASK,
  );
  echoesByTask = new Map(echoesByTask).set(taskId, next);
  emit();
}

export function closeQuestion(questionId: string) {
  if (closedQuestions.has(questionId)) return;
  closedQuestions = new Set(closedQuestions).add(questionId);
  emit();
}

export function useLocalEchoes(taskId: string): readonly LocalEcho[] {
  return useSyncExternalStore(subscribe, () => echoesByTask.get(taskId) ?? EMPTY);
}

export function useClosedQuestions(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => closedQuestions);
}

/** Test-only reset between cases. */
export function resetCodeAgentLocalState() {
  drafts.clear();
  pendingCodeTurns.clear();
  echoesByTask = new Map();
  closedQuestions = new Set();
  emit();
}
