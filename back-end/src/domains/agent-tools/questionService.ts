/**
 * Pinned-question answers. Agents cannot open new pinned questions (display
 * refuses placement "pinned"); this only resolves an existing question row.
 *
 *   answerQuestion: POST /api/agents/:id/questions/:questionId/answer (UI card)
 *   → resolveAndSignal (CAS on userResponse, finishes the pin row, signals a
 *   waiting Rose agent; sandbox rows are long-polled instead). First answer
 *   wins; an identical replay is 200, a different late answer is 409.
 */
import { resumePausedAgentForUserMessage } from '../../providers/agentResume';
import { resolveAndSignal } from '../../providers/gateResolution';
import { createLogger } from '../../providers/logger';
import { REJECTED_RESPONSE } from './config';
import * as repo from './repo';
import { marker, stateOf, storedQuestion, type AttentionRow } from './requestService';
import { AgentToolsError } from './service';
import type { RequestState } from './types';

const log = createLogger('AgentToolsQuestions');

/**
 * POST /api/agents/:id/questions/:questionId/answer — the UI's pinned-card
 * answer.
 *
 *   :id is the agent whose trajectory shows the pin (row.agentId) or the
 *   agent it is routed to (the root, for a root-spawned sub-agent's question).
 *   The first answer wins: replaying that same answer returns it (200); a
 *   different late answer or dismiss, including the loser of two racing
 *   answers, gets 409 naming the stored answer. A number 1–9 picks that
 *   option and is stored as its label. Resolution reuses resolveAndSignal, so
 *   the waiting Rose agent resumes through receive_user_response and a waiting
 *   sandbox's long-poll returns the answer.
 */
export async function answerQuestion(input: {
  agentId: string;
  questionId: string;
  userId: string | null;
  answer: string | null;
  dismiss: boolean;
  /** True for the user's own session; false for an agent answering via the internal key. */
  byUser: boolean;
}): Promise<RequestState> {
  const row = await repo.findAttentionRequest(input.questionId);
  const tag = row === null ? null : marker(row);
  if (
    row === null ||
    tag === null ||
    tag.kind !== 'question' ||
    (input.agentId !== row.agentId && input.agentId !== tag.routedAgentId)
  ) {
    throw new AgentToolsError(404, 'Question not found');
  }
  if (input.userId !== null && input.userId !== row.userId) {
    throw new AgentToolsError(
      403,
      'Switch to the account that owns this question, then try again.'
    );
  }
  if (row.userResponse !== null) {
    // Answered already: an identical replay is idempotent; anything else lost.
    if (lateAnswer(row, input) !== row.userResponse) throw alreadyAnswered(row.userResponse);
    return stateOf(row, null);
  }
  const response = normalizedAnswer(row, input);
  const { resolved } = await resolveAndSignal(row, response);
  // The user's answer is a send like any message, so it lifts a pause they set.
  if (resolved && input.byUser) await resumePausedAgentForUserMessage(row.agentId);
  log.info('Pinned question answered', {
    agent_id: row.agentId,
    request_id: row.id,
    deliver_to: tag.deliverTo,
    dismissed: input.dismiss,
    resolved,
  });
  const fresh = (await repo.findAttentionRequest(row.id)) ?? row;
  // A racing answer won between our read and our write.
  if (!resolved && fresh.userResponse !== null && fresh.userResponse !== response) {
    throw alreadyAnswered(fresh.userResponse);
  }
  return stateOf(fresh, null);
}

/** The stored form of an answer: an option label (by label or 1–9), free text, or dismissed. */
function normalizedAnswer(
  row: AttentionRow,
  input: { answer: string | null; dismiss: boolean }
): string {
  if (input.dismiss) return REJECTED_RESPONSE;
  const { options, allowOther } = storedQuestion(row);
  const text = (input.answer ?? '').trim();
  if (!text) throw new AgentToolsError(400, 'answer must be non-empty (or send dismiss: true)');
  const byNumber =
    /^[1-9]$/.test(text) && Number(text) <= options.length ? options[Number(text) - 1] : null;
  const option = byNumber ?? options.find((candidate) => candidate.label === text) ?? null;
  if (option === null && !allowOther) {
    throw new AgentToolsError(
      400,
      `answer must be one of: ${options.map((o) => o.label).join(', ')}`
    );
  }
  return option?.label ?? text;
}

/** A late answer's stored form, or null when it is not even a valid answer. */
function lateAnswer(
  row: AttentionRow,
  input: { answer: string | null; dismiss: boolean }
): string | null {
  try {
    return normalizedAnswer(row, input);
  } catch {
    return null;
  }
}

function alreadyAnswered(stored: string): AgentToolsError {
  const what =
    stored.trim() === REJECTED_RESPONSE ? 'already dismissed' : `already answered: "${stored}"`;
  return new AgentToolsError(409, `This question was ${what}. The first answer wins.`);
}
