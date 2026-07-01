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
  network: {
    description: 'Contact network records',
    table: 'Person' as const,
    searchField: 'contact fields',
    groupBy: 'personId',
  },
  agent_network: {
    description: 'Messages across the current agent tree',
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
  '-A'?: string | number;
  '-B'?: string | number;
  '-C'?: string | number;
  context?: string | number;
  '-n'?: boolean | string;
  '-i'?: boolean | string;
  head_limit?: string | number;
  offset?: string | number;
  multiline?: boolean | string;
  // messages-source-only narrowing
  person?: string;
  since?: string;
  agent_id?: string;
  user_id?: string;
}

export interface GrepLocation {
  source: ValidSource;
  path: string;
  agent_id?: string;
  message_id?: string;
  role?: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  thread?: string;
  contact_id?: string;
  field?: string;
}

export interface GrepMatch {
  source: ValidSource;
  path: string;
  pointer: string;
  timestamp: string;
  role?: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  location: GrepLocation;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  total_matches: number;
  truncated: boolean;
  pattern: string;
  sources: ValidSource[];
  applied_limit: number;
  applied_offset: number;
  message?: string;
}

// Normalized, validated grep input shared by the service (validation) and the
// formatter (snippet rendering).
export interface ValidatedGrepInput {
  pattern: string;
  sources: ValidSource[];
  regex: RegExp;
  dbPattern: string;
  caseInsensitive: boolean;
  multiline: boolean;
  showLineNumbers: boolean;
  contextBefore: number;
  contextAfter: number;
  headLimit: number;
  offset: number;
  // messages-source-only narrowing (resolved/parsed)
  person?: string;
  since?: Date;
}

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
