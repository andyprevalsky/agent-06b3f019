/**
 * Data domain error classes. Mapped to HTTP status codes in routes.ts.
 */

import { VALID_SOURCES } from './types';

export class InvalidPatternError extends Error {
  constructor(message?: string) {
    super(message ?? "Required field 'pattern' must be a string.");
    this.name = 'InvalidPatternError';
  }
}

export class SourceNotFoundError extends Error {
  public availableSources: string[];
  constructor(source: string) {
    const available = Object.keys(VALID_SOURCES);
    super(`Unknown source: '${source}'. Available sources: ${available.join(', ')}`);
    this.name = 'SourceNotFoundError';
    this.availableSources = available;
  }
}

export class InvalidGrepParamError extends Error {
  constructor(param: string) {
    super(`Unsupported grep parameter: '${param}'.`);
    this.name = 'InvalidGrepParamError';
  }
}

export class MissingAgentIdError extends Error {
  constructor() {
    super('agent_id is required for agent_network grep.');
    this.name = 'MissingAgentIdError';
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found or does not belong to current user: ${agentId}`);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentPathNotFoundError extends Error {
  constructor(path: string) {
    super(`No agent at ${path} in this agent tree. Use an address printed by list_agents.`);
    this.name = 'AgentPathNotFoundError';
  }
}
