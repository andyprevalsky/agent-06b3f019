/**
 * Agent-tools request state and the answer long-poll. Agents cannot open new
 * questions or approvals through agent-tools (no approval route, no pinned display).
 *
 *   answers              existing POST /api/attention-requests/:id/respond | /reject
 *                         (approvals) or questionService.answerQuestion (questions)
 *   waitForRequest       one PK read per REQUEST_WAIT_POLL_MS for ≤ `wait` seconds,
 *                         then `pending`; the caller loops with no overall deadline;
 *                         the agent cancelled (archived) mid-wait → 410
 *
 * Code-agent rows carry metadata.sandboxTool, so resolveAndSignal never signals
 * a workflow for them: the sandbox long-polls instead.
 */
import { REJECTED_RESPONSE, REQUEST_WAIT_POLL_MS } from './config';
import * as repo from './repo';
import { AgentToolsError, agentCancelledError, type ToolContext } from './service';
import type { DisplayFilePointer, DisplayOption, RequestState } from './types';

export type AttentionRow = NonNullable<Awaited<ReturnType<typeof repo.findAttentionRequest>>>;

export interface AgentToolsMarker {
  kind: 'approval' | 'question';
  deliverTo: 'user' | 'agent';
  routedAgentId: string;
}

export function marker(row: AttentionRow): AgentToolsMarker | null {
  const metadata = row.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).agentTools;
  if (value === null || typeof value !== 'object') return null;
  const { kind, deliverTo, routedAgentId } = value as Record<string, unknown>;
  if (
    (kind !== 'approval' && kind !== 'question') ||
    (deliverTo !== 'user' && deliverTo !== 'agent')
  ) {
    return null;
  }
  return {
    kind,
    deliverTo,
    routedAgentId: typeof routedAgentId === 'string' ? routedAgentId : row.agentId,
  };
}

interface StoredQuestion {
  options: DisplayOption[];
  allowOther: boolean;
  items: DisplayFilePointer[];
}

/** The question exactly as first stored, so every retry re-renders identical rows. */
export function storedQuestion(row: AttentionRow): StoredQuestion {
  const metadata = row.metadata as Record<string, unknown> | null;
  const question = (metadata?.displayQuestion ?? {}) as Partial<StoredQuestion>;
  return {
    options: Array.isArray(question.options) ? question.options : [],
    allowOther: question.allowOther !== false,
    items: Array.isArray(question.items) ? question.items : [],
  };
}

export function stateOf(row: AttentionRow, userMessage: string | null): RequestState {
  const tag = marker(row);
  const kind = tag?.kind ?? 'approval';
  const deliverTo = tag?.deliverTo ?? 'user';
  const response = row.userResponse;
  if (response === null) {
    return {
      id: row.id,
      kind,
      status: 'pending',
      response: null,
      user_message: null,
      selected_option: null,
      deliver_to: deliverTo,
      answered_by: null,
    };
  }
  const rejected = response.trim() === REJECTED_RESPONSE;
  let selected: RequestState['selected_option'] = null;
  if (!rejected && kind === 'question') {
    const { options } = storedQuestion(row);
    const text = response.trim();
    let index = options.findIndex((option) => option.label === text);
    if (index < 0 && /^[1-9]$/.test(text) && Number(text) <= options.length)
      index = Number(text) - 1;
    if (index >= 0) selected = { index, label: options[index].label };
  }
  return {
    id: row.id,
    kind,
    status: rejected ? 'rejected' : 'answered',
    response: rejected ? null : response,
    user_message: userMessage,
    selected_option: selected,
    deliver_to: deliverTo,
    answered_by: deliverTo,
  };
}

async function loadOwned(ctx: ToolContext, requestId: string): Promise<AttentionRow> {
  const row = await repo.findAttentionRequest(requestId);
  if (
    row === null ||
    row.agentId !== ctx.agent.id ||
    row.userId !== ctx.agent.userId ||
    marker(row) === null
  ) {
    throw new AgentToolsError(404, 'Request not found');
  }
  return row;
}

/**
 * Mid-wait read: cancelling (archiving) the agent deletes its requests, so a
 * vanished row whose agent is now archived ends the wait as cancelled (410).
 */
async function loadOwnedUnlessCancelled(
  ctx: ToolContext,
  requestId: string
): Promise<AttentionRow> {
  try {
    return await loadOwned(ctx, requestId);
  } catch (err) {
    if (err instanceof AgentToolsError && err.status === 404) {
      const agent = await repo.findAgent(ctx.agent.id);
      if (agent !== null && agent.deletedAt !== null) throw agentCancelledError();
    }
    throw err;
  }
}

/** One poll interval of the bounded long-poll (a wait for an answer, not a retry). */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Current state, holding up to `waitSeconds` for an answer (bounded long-poll). */
export async function waitForRequest(
  ctx: ToolContext,
  requestId: string,
  waitSeconds: number,
  signal?: AbortSignal
): Promise<RequestState> {
  const deadline = Date.now() + waitSeconds * 1000;
  let row = await loadOwned(ctx, requestId);
  while (row.userResponse === null && Date.now() < deadline && signal?.aborted !== true) {
    await pause(Math.min(REQUEST_WAIT_POLL_MS, deadline - Date.now()));
    row = await loadOwnedUnlessCancelled(ctx, requestId);
  }
  const userMessage =
    row.userResponse === null ? null : await repo.findAuthoredReply(row.id, row.agentId);
  return stateOf(row, userMessage);
}
