/**
 * Data domain types — Zod schemas, interfaces, type aliases.
 */

// Valid data sources with their configuration
// TODO: Add more sources as we expand (contacts, emails, calendar, etc.)
export const VALID_SOURCES = {
  messages: {
    description: 'iMessage and email conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
  },
  agent_network_user_messages: {
    description: 'User messages across the agent network',
    table: 'Message' as const,
    searchField: 'text',
    groupBy: 'agentId',
  },
  agent_network_tool_results: {
    description: 'Tool call results across the agent network',
    table: 'Message' as const,
    searchField: 'text',
    groupBy: 'agentId',
  },
} as const;

export type ValidSource = keyof typeof VALID_SOURCES;

export interface PersonInfo {
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  email: string | null;
}

export interface ThreadMessage {
  channel: string;
  from: string;
  to: string;
  timestamp: string;
  message: string;
  is_match: boolean;
}

export interface FormattedResult {
  thread: string;
  person: PersonInfo;
  messages: ThreadMessage[];
}

export interface GrepParams {
  pattern: string;
  source?: string;
  since?: string;
  limit?: string | number;
  person_id?: string;
  agent_id?: string;
}

export interface AgentNetworkMatch {
  agent_id: string;
  message_id: string;
  role: string;
  text: string;
  timestamp: string;
  pointer: string;
}

export interface AgentNetworkGrepResult {
  matches: AgentNetworkMatch[];
  total_matches: number;
  truncated: boolean;
  message?: string;
}

export interface GrepNoMatchResult {
  matches: FormattedResult[];
  total_matches: 0;
  truncated: false;
  message: string;
}

export interface GrepMatchResult {
  matches: FormattedResult[];
  total_matches: number;
  truncated: boolean;
  truncation_message?: string;
  pattern: string;
  source: ValidSource;
  since: string;
}

export type GrepResult = GrepNoMatchResult | GrepMatchResult;

export interface SummaryThreadInfo {
  name: string;
  message_count: number;
  last_message: string;
}

export interface SummaryResult {
  sources: {
    messages: {
      total_threads: number;
      total_messages: number;
      channels: Record<string, number>;
      date_range: {
        from: string | null;
        to: string | null;
      };
      threads: SummaryThreadInfo[];
    };
  };
}
