/** Filters for grep over agent messages. */

export interface AgentNetworkGrepFilters {
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
}

export interface AgentTrajectoryGrepFilters {
  pathRootAgentId?: string;
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
  since?: Date;
  until?: Date;
  role?: 'USER' | 'ASSISTANT' | 'TOOL';
  surface?: 'WEB' | 'MAC_APP' | 'SMS' | 'WHATSAPP';
  recordKind?: 'all' | 'message' | 'llm_output' | 'llm_context';
}
