/**
 * Agent network grep service — search across agent tree messages.
 * Supports context pointer resolution via @ref:message:<id> pointers.
 */

import { MAX_RESULTS } from './config';
import type { GrepParams, AgentNetworkGrepResult } from './types';
import * as repo from './repo';
import { createLogger } from '../../providers/logger';

const log = createLogger('Data');

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class MissingAgentIdError extends Error {
  constructor() {
    super('agent_id is required for agent_network sources');
    this.name = 'MissingAgentIdError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found or does not belong to current user: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

export class InvalidPatternError extends Error {
  constructor() {
    super(
      "Required field 'pattern' must be a string. Use '' to return all messages, or search for keywords."
    );
    this.name = 'InvalidPatternError';
  }
}

// ---------------------------------------------------------------------------
// Agent Network Grep
// ---------------------------------------------------------------------------

const MAX_AGENT_NETWORK_TEXT = 500;

export async function grepAgentNetwork(
  userId: string,
  params: GrepParams
): Promise<AgentNetworkGrepResult> {
  const { pattern, source, limit, agent_id } = params;

  if (agent_id === undefined || agent_id === '') {
    throw new MissingAgentIdError();
  }

  if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
    throw new InvalidPatternError();
  }

  // Verify agent belongs to user
  const agent = await repo.findAgentByIdAndUser(agent_id, userId);
  if (agent === null) {
    throw new AgentNotFoundError(agent_id);
  }

  // Walk up to root, then BFS down to get full tree
  const rootId = await repo.findRootAgentId(agent_id, userId);
  const treeIds = await repo.findAgentTreeIds(rootId, userId);

  const resolvedLimit = Math.min(Math.max(parseInt(String(limit)) || 20, 1), MAX_RESULTS);
  const role: 'USER' | 'TOOL' = source === 'agent_network_user_messages' ? 'USER' : 'TOOL';

  const messages = await repo.searchAgentNetworkMessages({
    agentIds: treeIds,
    pattern: pattern.trim(),
    role,
    limit: resolvedLimit,
  });

  if (messages.length === 0) {
    log.info(
      `grep: no matches for '${pattern}' in ${source ?? 'agent_network'} (${treeIds.length} agents)`
    );
    return {
      matches: [],
      total_matches: 0,
      truncated: false,
      message: `No matches for '${pattern}' in ${source ?? 'agent_network'} (searched ${treeIds.length} agents in tree). Try different keywords.`,
    };
  }

  const formattedMatches = messages.map((msg) => ({
    agent_id: msg.agentId,
    message_id: msg.id,
    role: msg.role,
    text:
      msg.text.length > MAX_AGENT_NETWORK_TEXT
        ? msg.text.substring(0, MAX_AGENT_NETWORK_TEXT) + '...'
        : msg.text,
    timestamp: msg.createdAt.toISOString(),
    pointer: `@ref:message:${msg.id}`,
  }));

  log.info(
    `grep: '${pattern}' -> ${messages.length} matches in ${source ?? 'agent_network'} (${treeIds.length} agents)`
  );

  return {
    matches: formattedMatches,
    total_matches: messages.length,
    truncated: false,
  };
}
