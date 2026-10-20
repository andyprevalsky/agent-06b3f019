/**
 * Agent graph: code agents (Claude Code / Codex sessions) and Rose agents of
 * ONE tree can list each other, message each other and grep the tree.
 *
 *   caller (token: code session | API key + X-Agent-Id: Rose agent)
 *     ├─ list  → tree agents (BFS from root) + their code sessions
 *     ├─ send  → Rose agent: idempotent USER message (normal postMessage path)
 *     │          code agent: ws user_message → CLI's next user turn, plus an
 *     │                      idempotent chip row on the owning agent
 *     └─ grep  → agent_trajectories, path pinned to agent_trajectories/<root>
 *
 * Scope: every target is resolved by walking ITS parent links to a root and
 * comparing with the caller's root + user. Anything outside → 404 (no
 * existence oracle across users or trees). 10k agents: one tree walk per
 * request (O(depth) indexed lookups), one short ws per code-agent message,
 * no fan-out and no shared channel.
 */
import { createMessage } from '../../providers/messages';
import { agentGraphMessageRowId } from '../../providers/messageIds';
import { deliverToCodeSession } from '../../providers/agentGraph/codeSessionInbox';
import { executeUserDataGrep, type UserDataGrepResult } from '../../providers/userDataSearch';
import { createLogger } from '../../providers/logger';
import * as messageService from './agentMessageService';
import * as graphRepo from './repoGraph';

const log = createLogger('AgentGraph');

export type GraphSelf =
  | { kind: 'code'; id: string; ownerAgentId: string; provider: 'claude' | 'codex' }
  | { kind: 'agent'; id: string };

export interface GraphCaller {
  userId: string;
  rootAgentId: string;
  self: GraphSelf;
}

export class AgentGraphError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const NOT_FOUND = 'Agent not found in this tree';

/** Resolve an internal (API key) caller from the Rose agent it acts for. */
export async function callerForAgent(agentId: string): Promise<GraphCaller> {
  const agent = await graphRepo.findGraphAgent(agentId);
  if (agent === null) throw new AgentGraphError(404, 'Agent not found');
  const rootAgentId = await graphRepo.findGraphRootId(agent.id, agent.userId);
  if (rootAgentId === null) throw new AgentGraphError(404, 'Agent not found');
  return { userId: agent.userId, rootAgentId, self: { kind: 'agent', id: agent.id } };
}

/** A code-session caller is valid only while its session still exists. */
export async function assertCodeCallerLive(caller: GraphCaller): Promise<void> {
  if (caller.self.kind !== 'code') return;
  const session = await graphRepo.findGraphCodeSession(caller.self.id);
  if (session === null || session.agentId !== caller.self.ownerAgentId) {
    throw new AgentGraphError(401, 'Code session no longer exists');
  }
}

async function inCallerTree(caller: GraphCaller, agentId: string): Promise<boolean> {
  const root = await graphRepo.findGraphRootId(agentId, caller.userId);
  return root === caller.rootAgentId;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: 'agent' | 'code';
  provider?: 'claude' | 'codex';
  parent_id: string | null;
  depth: number;
  status: string;
  title: string | null;
  goal: string;
  relation: 'self' | 'root' | 'parent' | 'sibling' | 'child' | 'other';
  created_at: string;
}

const GOAL_PREVIEW_CHARS = 300;

function relationOf(
  self: GraphSelf,
  selfParentId: string | null,
  node: { id: string; parentId: string | null },
  rootAgentId: string
): GraphNode['relation'] {
  if (node.id === self.id) return 'self';
  if (node.id === rootAgentId) return 'root';
  if (selfParentId !== null && node.id === selfParentId) return 'parent';
  if (node.parentId !== null && node.parentId === self.id) return 'child';
  if (selfParentId !== null && node.parentId === selfParentId) return 'sibling';
  return 'other';
}

export async function listGraph(caller: GraphCaller): Promise<{
  root_agent_id: string;
  self_id: string;
  truncated: boolean;
  agents: GraphNode[];
}> {
  const agents = await graphRepo.listGraphTreeAgents(caller.rootAgentId, caller.userId);
  const sessions = await graphRepo.listGraphCodeSessions(agents.map((agent) => agent.id));
  const depthById = new Map(agents.map((agent) => [agent.id, agent.treeDepth]));
  const selfParentId =
    caller.self.kind === 'code'
      ? caller.self.ownerAgentId
      : (agents.find((agent) => agent.id === caller.self.id)?.parentAgentId ?? null);

  const nodes: GraphNode[] = [];
  for (const agent of agents) {
    nodes.push({
      id: agent.id,
      kind: 'agent',
      parent_id: agent.parentAgentId,
      depth: agent.treeDepth,
      status: agent.status,
      title: agent.title,
      goal: agent.goal.slice(0, GOAL_PREVIEW_CHARS),
      relation: relationOf(
        caller.self,
        selfParentId,
        { id: agent.id, parentId: agent.parentAgentId },
        caller.rootAgentId
      ),
      created_at: agent.createdAt.toISOString(),
    });
    for (const session of sessions) {
      if (session.agentId !== agent.id) continue;
      nodes.push({
        id: session.id,
        kind: 'code',
        ...(caller.self.kind === 'code' && caller.self.id === session.id
          ? { provider: caller.self.provider }
          : {}),
        parent_id: session.agentId,
        depth: (depthById.get(session.agentId) ?? 0) + 1,
        status: session.status,
        title: null,
        goal: session.goal.slice(0, GOAL_PREVIEW_CHARS),
        relation: relationOf(
          caller.self,
          selfParentId,
          { id: session.id, parentId: session.agentId },
          caller.rootAgentId
        ),
        created_at: session.createdAt.toISOString(),
      });
    }
  }
  return {
    root_agent_id: caller.rootAgentId,
    self_id: caller.self.id,
    truncated: agents.length >= graphRepo.GRAPH_MAX_NODES,
    agents: nodes,
  };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface SendInput {
  to: string;
  text: string;
  message_id: string;
}

export interface SendResult {
  message_id: string;
  status: 'queued' | 'delivered' | 'duplicate';
  to: { id: string; kind: 'agent' | 'code' };
}

function senderLabel(caller: GraphCaller): string {
  if (caller.self.kind === 'code') return `code agent ${caller.self.id}`;
  if (caller.self.id === caller.rootAgentId) return `root agent ${caller.self.id}`;
  return `agent ${caller.self.id}`;
}

function senderMetadata(caller: GraphCaller): Record<string, unknown> {
  return caller.self.kind === 'code'
    ? {
        id: caller.self.id,
        kind: 'code',
        provider: caller.self.provider,
        owner_agent_id: caller.self.ownerAgentId,
      }
    : { id: caller.self.id, kind: 'agent' };
}

/** LLM-visible framing of an inbound agent message (prompt-scoped text). */
export function formatInboundAgentMessage(label: string, text: string): string {
  return `Message from ${label} (reply with its id):\n\n${text}`;
}

type Target =
  | { kind: 'agent'; id: string }
  | { kind: 'code'; id: string; ownerAgentId: string; streamUrl: string | null; status: string };

async function resolveTarget(caller: GraphCaller, to: string): Promise<Target> {
  const agent = await graphRepo.findGraphAgent(to);
  if (agent !== null) {
    if (agent.userId !== caller.userId || !(await inCallerTree(caller, agent.id))) {
      throw new AgentGraphError(404, NOT_FOUND);
    }
    return { kind: 'agent', id: agent.id };
  }
  const session = await graphRepo.findGraphCodeSession(to);
  if (session !== null && (await inCallerTree(caller, session.agentId))) {
    return {
      kind: 'code',
      id: session.id,
      ownerAgentId: session.agentId,
      streamUrl: session.streamUrl,
      status: session.status,
    };
  }
  throw new AgentGraphError(404, NOT_FOUND);
}

export async function sendGraphMessage(caller: GraphCaller, input: SendInput): Promise<SendResult> {
  if (input.to === caller.self.id) throw new AgentGraphError(400, 'Cannot message yourself');
  const target = await resolveTarget(caller, input.to);
  // Keyed by sender so two agents can never collide on a client-chosen id.
  const key = `${caller.self.id}:${input.message_id}`;
  const label = senderLabel(caller);
  const a2a = { from: senderMetadata(caller), to: { id: target.id, kind: target.kind } };
  const text = formatInboundAgentMessage(label, input.text);

  if (target.kind === 'agent') {
    const existing = await graphRepo.findMessageById(agentGraphMessageRowId(target.id, key));
    if (existing !== null) {
      return { message_id: input.message_id, status: 'duplicate', to: target };
    }
    const posted = await messageService.postMessage(
      target.id,
      { message: text, role: 'USER', metadata: { a2aMessageId: key, a2a } },
      false,
      caller.userId
    );
    if ('error' in posted) throw new AgentGraphError(posted.status ?? 500, posted.error);
    log.info('Delivered agent message', { from: caller.self.id, to: target.id, key });
    return { message_id: input.message_id, status: 'delivered', to: target };
  }

  // Code agent: the ws-server dedupes by key, so a retry after a lost ack (or
  // after the chip write below failed) never starts a second CLI turn.
  if (target.streamUrl === null || target.status !== 'ACTIVE') {
    throw new AgentGraphError(409, 'Code agent session is not running');
  }
  const delivery = await deliverToCodeSession(target.streamUrl, { id: key, text });
  if (delivery.status === 'finished') {
    throw new AgentGraphError(409, delivery.reason ?? 'Code agent session has finished');
  }
  if (delivery.status === 'rejected') {
    throw new AgentGraphError(502, delivery.reason ?? 'Code agent rejected the message');
  }
  const toolCallId = await graphRepo.findCodeSessionToolCallId(target.ownerAgentId, target.id);
  // Child-scoped chip (subAgentId) so it renders in the code agent's timeline
  // and stays out of the owning agent's LLM context. No toolStatus: this is
  // not a lifecycle row of the spawn tool call.
  await createMessage({
    agentId: target.ownerAgentId,
    role: 'TOOL',
    text,
    metadata: {
      a2aMessageId: key,
      a2a,
      title: `Message from ${label}`,
      task_id: target.id,
      subAgentId: target.id,
      action_type: 'agent_message',
      ...(toolCallId !== null ? { toolCallId, toolName: 'spawn_claude_code_agent' } : {}),
    },
  });
  log.info('Delivered code agent message', {
    from: caller.self.id,
    to: target.id,
    key,
    status: delivery.status,
  });
  return {
    message_id: input.message_id,
    status: delivery.status === 'duplicate' ? 'duplicate' : 'queued',
    to: { id: target.id, kind: 'code' },
  };
}

// ---------------------------------------------------------------------------
// Grep
// ---------------------------------------------------------------------------

export interface GrepInput {
  pattern: string;
  agent_id?: string;
  role?: 'USER' | 'ASSISTANT' | 'TOOL';
  head_limit?: number;
  case_insensitive?: boolean;
  since?: string;
  until?: string;
}

export async function grepGraph(
  caller: GraphCaller,
  input: GrepInput
): Promise<UserDataGrepResult> {
  let path = `agent_trajectories/${caller.rootAgentId}`;
  if (input.agent_id !== undefined) {
    if (!(await inCallerTree(caller, input.agent_id))) throw new AgentGraphError(404, NOT_FOUND);
    path = `${path}/${input.agent_id}`;
  }
  return executeUserDataGrep(caller.userId, {
    source: 'agent_trajectories',
    pattern: input.pattern,
    filters: { path },
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.head_limit !== undefined ? { head_limit: input.head_limit } : {}),
    ...(input.case_insensitive === true ? { '-i': true } : {}),
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.until !== undefined ? { until: input.until } : {}),
  });
}
