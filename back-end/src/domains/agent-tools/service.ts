/**
 * Rose agent tools: the ways an agent talks to the user — or, for nested
 * agents, to its parent — without anyone reading a raw terminal.
 *
 *   code-agent sandbox ── rose CLI / rose mcp ──┐ (Bearer rtt.<token>, ONE agent)
 *   Rose agent (agents worker) ─────────────────┤ (X-API-Key, internal)
 *                                               ▼
 *   /api/agent-tools/:agentId
 *     POST /display     inline media (image/*, video/*, text/html) or a pinned question
 *     POST /messages    send_message_to_user (text + inline_view)        [code agents]
 *     POST /approvals   request_user_approval → existing ApprovalChip    [code agents]
 *     GET  /requests/:id?wait=N   long-poll the answer (no overall deadline)
 *
 *   Answers arrive through the existing attention-request endpoints
 *   (POST /api/attention-requests/:id/respond | /reject), so the user — or a
 *   parent agent for a parent-routed question — answers exactly like any gate.
 *
 * This file holds the shared context (who is calling, whose trajectory, who
 * answers); displayService / requestService / messageService hold the flows.
 *
 * 10k-agent behaviour: every call is bounded (≤ 20 items, ≤ 9 options) and
 * touches only the caller's agent row, its parent, and its own messages on its
 * own per-agent channel. A waiting caller costs one primary-key read per 2 s
 * poll and nothing while no request is pending.
 */
import { createHash } from '../../providers/crypto';
import { routeQuestion, type QuestionRoute } from '../../providers/agentTools/routing';
import * as repo from './repo';
import type { AgentToolsCaller, RequestingAgent } from './types';

export class AgentToolsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: string[]
  ) {
    super(message);
  }
}

export interface ToolContext {
  caller: AgentToolsCaller;
  /** The agent whose trajectory holds the caller's messages. */
  agent: repo.ToolAgent;
  requesting: RequestingAgent;
  route: QuestionRoute;
  /** Current workflow generation stamped on backend-written lifecycle rows. */
  workflowGeneration: string;
}

function agentLabel(agent: repo.ToolAgent): string {
  const title = agent.title?.trim() ?? '';
  if (title.length > 0) return title.slice(0, 80);
  const goal = agent.goal.trim().replace(/\s+/g, ' ');
  return goal.length > 60 ? `${goal.slice(0, 57)}…` : goal || 'Agent';
}

function requestingAgentFor(caller: AgentToolsCaller, agent: repo.ToolAgent): RequestingAgent {
  if (caller.kind === 'code_agent') {
    const provider = caller.provider ?? 'claude';
    return {
      kind: 'code_agent',
      agent_id: agent.id,
      label: provider === 'codex' ? 'Codex' : 'Claude Code',
      provider,
      ...(caller.taskId !== null ? { task_id: caller.taskId } : {}),
    };
  }
  return { kind: 'agent', agent_id: agent.id, label: agentLabel(agent) };
}

/** Load the caller's agent, check ownership, and decide who answers its questions. */
export async function resolveContext(caller: AgentToolsCaller): Promise<ToolContext> {
  const agent = await repo.findAgent(caller.agentId);
  if (agent === null || agent.deletedAt !== null) throw new AgentToolsError(404, 'Agent not found');
  if (caller.userId !== null && caller.userId !== agent.userId) {
    throw new AgentToolsError(403, 'Not allowed to use agent tools for this agent');
  }
  // A code agent is spawned by the session's agent; a Rose agent by its parent.
  let spawner: { id: string; parentAgentId: string | null } | null;
  if (caller.kind === 'code_agent') {
    spawner = { id: agent.id, parentAgentId: agent.parentAgentId };
  } else if (agent.parentAgentId === null) {
    spawner = null;
  } else {
    const parent = await repo.findAgent(agent.parentAgentId);
    spawner =
      parent === null || parent.userId !== agent.userId
        ? null
        : { id: parent.id, parentAgentId: parent.parentAgentId };
  }
  return {
    caller,
    agent,
    requesting: requestingAgentFor(caller, agent),
    route: routeQuestion({ trajectoryAgentId: agent.id, spawner }),
    workflowGeneration: agent.temporalWorkflowId ?? agent.id,
  };
}

/** Metadata every backend-written row from a code agent carries. */
export function sandboxRowMetadata(ctx: ToolContext): Record<string, unknown> {
  if (ctx.caller.kind !== 'code_agent') return {};
  // Code-agent rows live in the session agent's trajectory but are not that
  // agent's own turns: keep them out of its model context (UI-only), grouped
  // under the code-agent chip by task id.
  return {
    excludeFromModel: true,
    ...(ctx.caller.taskId !== null
      ? { subAgentId: ctx.caller.taskId, task_id: ctx.caller.taskId }
      : {}),
  };
}

/** Deterministic attention-request id for (agent, kind, key): retries reuse the row. */
export function requestIdFor(agentId: string, kind: string, key: string): string {
  return `atq_${createHash('sha256').update(`${agentId}:${kind}:${key}`).digest('hex').slice(0, 32)}`;
}
