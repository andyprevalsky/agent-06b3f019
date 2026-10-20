/** Filters for grep over agent messages. */

export interface AgentMetadataParams {
  role?: string;
  record_kind?: string;
  surface?: string;
  trace_path?: string;
  until?: string;
  order?: 'newest_first' | 'oldest_first';
  page_after?: string;
}

export interface AgentNetworkGrepFilters {
  pathAgentId?: string;
  pathRole?: string;
  pathMessageId?: string;
  role?: string;
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
  recordKind?: 'all' | 'message' | 'llm_output' | 'llm_context' | 'code_event';
}
