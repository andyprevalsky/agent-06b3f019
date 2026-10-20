/**
 * Blocking agent tools, shared state: approvals and the answer long-poll.
 *
 *   createApproval(ctx)  [code agents] → attention row (id from request_key, retry → same
 *                         row) + the existing ApprovalChip row in the session agent's
 *                         trajectory, labelled with the requesting agent
 *   answers              existing POST /api/attention-requests/:id/respond | /reject
 *                         (approvals) or questionService.answerQuestion (questions)
 *   waitForRequest       one PK read per REQUEST_WAIT_POLL_MS for ≤ `wait` seconds,
 *                         then `pending`; the caller loops with no overall deadline
 *
 * Code-agent rows carry metadata.sandboxTool, so resolveAndSignal never signals
 * a workflow for them: the sandbox long-polls instead.
 */
import { randomUUID } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import { createMessage } from '../../providers/messages';
import { REJECTED_RESPONSE, REQUEST_WAIT_POLL_MS } from './config';
import * as repo from './repo';
import { AgentToolsError, requestIdFor, sandboxRowMetadata, type ToolContext } from './service';
import type { DisplayFilePointer, DisplayOption, RequestState } from './types';

const log = createLogger('AgentToolsRequests');

export type AttentionRow = NonNullable<Awaited<ReturnType<typeof repo.findAttentionRequest>>>;

export interface AgentToolsMarker {
  kind: 'approval' | 'question';
  deliverTo: 'user' | 'parent';
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
    (deliverTo !== 'user' && deliverTo !== 'parent')
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

export async function workflowIdFor(
  ctx: ToolContext,
  requested: string | undefined
): Promise<string> {
  const workflowId =
    ctx.caller.kind === 'agent' && requested !== undefined
      ? requested
      : (ctx.agent.temporalWorkflowId ?? ctx.agent.id);
  try {
    await repo.assertWorkflowTarget(ctx.agent.userId, ctx.agent.id, workflowId);
  } catch {
    throw new AgentToolsError(403, 'workflow_id does not belong to this agent');
  }
  return workflowId;
}

/** request_user_approval from a code-agent sandbox: the existing ApprovalChip. */
export async function createApproval(
  ctx: ToolContext,
  input: { question: string; requestKey?: string }
): Promise<{ request_id: string; status: RequestState['status']; message_id: string | null }> {
  if (ctx.caller.kind !== 'code_agent') {
    throw new AgentToolsError(
      400,
      'Rose agents request approval with their own request_user_approval tool'
    );
  }
  const workflowId = await workflowIdFor(ctx, undefined);
  const id = requestIdFor(ctx.agent.id, 'approval', input.requestKey ?? randomUUID());
  const agentTools: AgentToolsMarker = {
    kind: 'approval',
    deliverTo: 'user',
    routedAgentId: ctx.agent.id,
  };
  const { row, created } = await repo.createAttentionRequestOnce({
    id,
    userId: ctx.agent.userId,
    agentId: ctx.agent.id,
    workflowId,
    question: input.question,
    metadata: {
      agentTools,
      toolApproval: true,
      requestingAgent: ctx.requesting,
      sandboxTool: { provider: ctx.requesting.provider, taskId: ctx.requesting.task_id ?? null },
    },
  });
  if (row.userResponse !== null) {
    return { request_id: row.id, status: stateOf(row, null).status, message_id: null };
  }
  const message = await createMessage({
    agentId: ctx.agent.id,
    text: row.question,
    role: 'TOOL',
    metadata: {
      toolCallId: `agent-tools:${row.id}`,
      toolName: 'request_user_approval',
      toolStatus: 'IN_PROGRESS',
      title: `🔐 ${ctx.requesting.label} requests approval`,
      workflowGeneration: ctx.workflowGeneration,
      isUserAttentionMessage: true,
      attentionMessage: row.question,
      requestUserApproval: {
        attentionRequestId: row.id,
        toolApproval: true,
        requestingAgent: ctx.requesting,
      },
      requestingAgent: ctx.requesting,
      ...sandboxRowMetadata(ctx),
    },
  });
  log.info(created ? 'Opened sandbox approval' : 'Reused sandbox approval', {
    agent_id: ctx.agent.id,
    request_id: row.id,
    provider: ctx.requesting.provider,
  });
  return { request_id: row.id, status: stateOf(row, null).status, message_id: message.id };
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
    row = await loadOwned(ctx, requestId);
  }
  const userMessage =
    row.userResponse === null ? null : await repo.findAuthoredReply(row.id, row.agentId);
  return stateOf(row, userMessage);
}
