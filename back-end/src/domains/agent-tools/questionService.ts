/**
 * Pinned questions (`display(..., placement: "pinned")`), routed by spawner
 * with the shared agent-graph decision (providers/agentGraph/questionRoute):
 *
 *   openQuestion(ctx)
 *     ├─ route user ─► attention row, id = requestIdFor(agent, "question", request_key)
 *     │                (retry → same row, same answer)
 *     │                  code agent ─► TOOL row "<agent> asks" (pinned above the query box)
 *     │                  Rose agent ─► pin metadata returned; the workflow posts its own
 *     │                                lifecycle row and waits on receive_user_response
 *     └─ route agent ─► nothing written here: the caller asks that agent through the
 *                       L-A2A path (code agents: POST /api/agent-graph/questions; Rose
 *                       agents: send_agent_graph_message_activity) and the answer
 *                       arrives as its next message
 *
 *   answerQuestion: POST /api/agents/:id/questions/:questionId/answer (UI card)
 *   → resolveAndSignal (CAS on userResponse, finishes the pin row, signals a
 *   waiting Rose agent; sandbox rows are long-polled instead).
 */
import { resumePausedAgentForUserMessage } from '../../providers/agentResume';
import { randomUUID } from '../../providers/crypto';
import { resolveAndSignal } from '../../providers/gateResolution';
import { createLogger } from '../../providers/logger';
import { createMessage } from '../../providers/messages';
import { REJECTED_RESPONSE } from './config';
import * as repo from './repo';
import {
  marker,
  stateOf,
  storedQuestion,
  workflowIdFor,
  type AgentToolsMarker,
  type AttentionRow,
} from './requestService';
import { AgentToolsError, requestIdFor, sandboxRowMetadata, type ToolContext } from './service';
import type { DisplayFilePointer, DisplayOption, DisplayResult, RequestState } from './types';

const log = createLogger('AgentToolsQuestions');

function pinnedMessageMetadata(ctx: ToolContext, row: AttentionRow): Record<string, unknown> {
  const { options, allowOther, items } = storedQuestion(row);
  return {
    isUserAttentionMessage: true,
    attentionMessage: row.question,
    attentionRequestId: row.id,
    // UI contract (rose-user-ui): the pinned card above the query box.
    display: {
      placement: 'pinned',
      kind: 'question',
      question: row.question,
      options,
      allow_other: allowOther,
      question_id: row.id,
      items,
      deliver_to: ctx.route.deliver_to,
      routed_agent_id: ctx.route.agent_id,
    },
    requestingAgent: ctx.requesting,
  };
}

/**
 * The code agent's own transcript row (and, for route user, the pin). Identical
 * metadata on retry → the lifecycle dedupe returns the same row.
 */
async function postCodeAgentQuestionRow(
  ctx: ToolContext,
  row: AttentionRow,
  messageMetadata: Record<string, unknown>
): Promise<string> {
  const message = await createMessage({
    agentId: ctx.agent.id,
    text: row.question,
    role: 'TOOL',
    metadata: {
      toolCallId: `agent-tools:${row.id}`,
      toolName: 'display',
      toolStatus: 'IN_PROGRESS',
      title: `${ctx.requesting.label} asks`,
      workflowGeneration: ctx.workflowGeneration,
      ...messageMetadata,
      ...sandboxRowMetadata(ctx),
    },
  });
  return message.id;
}

type OpenedQuestion = NonNullable<DisplayResult['question']> & {
  message_metadata: Record<string, unknown>;
};

/** Route "agent": nothing is stored; the caller asks its spawner via the agent graph. */
function routedToAgent(ctx: ToolContext): OpenedQuestion {
  log.info('Pinned question routed to the spawning agent', {
    agent_id: ctx.agent.id,
    routed_agent_id: ctx.route.agent_id,
    via: ctx.requesting.kind,
  });
  return {
    request_id: null,
    status: 'route_to_agent',
    deliver_to: 'agent',
    agent_id: ctx.route.agent_id,
    message_id: null,
    response: null,
    message_metadata: {},
  };
}

export async function openQuestion(
  ctx: ToolContext,
  input: {
    question: string;
    options: DisplayOption[];
    allowOther: boolean;
    media: DisplayFilePointer[];
    requestKey?: string;
    workflowId?: string;
  }
): Promise<OpenedQuestion> {
  if (ctx.route.deliver_to === 'agent') return routedToAgent(ctx);
  const workflowId = await workflowIdFor(ctx, input.workflowId);
  const id = requestIdFor(ctx.agent.id, 'question', input.requestKey ?? randomUUID());
  const agentTools: AgentToolsMarker = {
    kind: 'question',
    deliverTo: ctx.route.deliver_to,
    routedAgentId: ctx.route.agent_id,
  };
  const { row, created } = await repo.createAttentionRequestOnce({
    id,
    userId: ctx.agent.userId,
    agentId: ctx.agent.id,
    workflowId,
    question: input.question,
    metadata: {
      agentTools,
      displayQuestion: {
        options: input.options,
        allowOther: input.allowOther,
        items: input.media,
      },
      requestingAgent: ctx.requesting,
      ...(ctx.caller.kind === 'code_agent'
        ? {
            sandboxTool: {
              provider: ctx.requesting.provider,
              taskId: ctx.requesting.task_id ?? null,
            },
          }
        : {}),
    },
  });
  const messageMetadata = pinnedMessageMetadata(ctx, row);
  let messageId: string | null = null;
  const pending = row.userResponse === null;
  if (pending && ctx.caller.kind === 'code_agent') {
    messageId = await postCodeAgentQuestionRow(ctx, row, messageMetadata);
  }
  log.info(created ? 'Opened pinned question' : 'Reused pinned question', {
    agent_id: ctx.agent.id,
    request_id: row.id,
    deliver_to: ctx.route.deliver_to,
    routed_agent_id: ctx.route.agent_id,
    via: ctx.requesting.kind,
  });
  const state = stateOf(row, null);
  return {
    request_id: row.id,
    status: state.status,
    deliver_to: ctx.route.deliver_to,
    agent_id: ctx.route.agent_id,
    message_id: messageId,
    response: row.userResponse,
    message_metadata: messageMetadata,
  };
}

/**
 * POST /api/agents/:id/questions/:questionId/answer — the UI's pinned-card
 * answer.
 *
 *   :id is the agent whose trajectory shows the pin (row.agentId) or the
 *   agent it is routed to (the root, for a root-spawned sub-agent's question).
 *   Idempotent: an answered question
 *   returns its stored answer; the first answer wins. A number 1–9 picks that
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
  if (row.userResponse === null) {
    const { options, allowOther } = storedQuestion(row);
    let response: string;
    if (input.dismiss) {
      response = REJECTED_RESPONSE;
    } else {
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
      response = option?.label ?? text;
    }
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
  }
  const fresh = await repo.findAttentionRequest(row.id);
  return stateOf(fresh ?? row, null);
}
