/**
 * Data domain types — Zod schemas, interfaces, type aliases.
 */

export const DATA_SOURCE_CONFIGS = {
  messages: {
    description: 'iMessage and email conversation threads (all channels)',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since'] as const,
    // Umbrella source: no connector requirement, no channel restriction.
    connector: null,
    channel: null,
  },
  gmail: {
    description: 'Gmail/email conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since'] as const,
    // Alias of `email`; kept for backward compatibility.
    connector: 'gmail',
    channel: 'EMAIL',
  },
  email: {
    description: 'Email conversation threads (Gmail-connected)',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since'] as const,
    connector: 'gmail',
    channel: 'EMAIL',
  },
  imessage: {
    description: 'iMessage conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since'] as const,
    connector: 'imessage',
    channel: 'IMESSAGE',
  },
  whatsapp: {
    description: 'WhatsApp conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since'] as const,
    connector: 'whatsapp',
    channel: 'WHATSAPP',
  },
  network: {
    description: 'Contact network records',
    table: 'Person' as const,
    searchField: 'contact fields',
    groupBy: 'personId',
    filters: [] as const,
    connector: null,
    channel: null,
  },
  agent_network: {
    description: 'Messages across the current agent tree',
    table: 'Message' as const,
    searchField: 'text',
    groupBy: 'agentId',
    filters: [] as const,
    connector: null,
    channel: null,
  },
  transactions: {
    description: 'Plaid financial transactions',
    table: 'PlaidTransaction' as const,
    searchField: 'transaction fields',
    groupBy: 'plaidAccountId',
    filters: [
      'since',
      'until',
      'account',
      'min_amount',
      'max_amount',
      'status',
      'include_pending_in_totals',
    ] as const,
    connector: 'plaid',
    channel: null,
  },
  documents: {
    description: 'Synced text documents from LLM exports, Apple Notes, Obsidian, and generic files',
    table: 'UserDataDocument' as const,
    searchField: 'title/content/metadata',
    groupBy: 'source',
    filters: ['document_source', 'since', 'until', 'path', 'tag'] as const,
    connector: 'documents',
    channel: null,
  },
} as const;

export const VALID_SOURCES = DATA_SOURCE_CONFIGS;

export type ValidSource = keyof typeof DATA_SOURCE_CONFIGS;
export const DEFAULT_GREP_SOURCES: ValidSource[] = ['messages', 'network', 'agent_network'];

/**
 * Message-family sources all search `MessageRecord`. The channel-specific ones
 * (email/imessage/whatsapp) additionally restrict to a single
 * `MessageRecord.channel` value; the umbrella `messages` and legacy `gmail`
 * keep their existing search behavior.
 *
 * There is no separate `sms` grep source: macOS SMS lives in the Messages DB
 * and is ingested as `IMESSAGE` via the iMessage connector. `MessageChannel`
 * has no SMS variant.
 */
export const MESSAGE_FAMILY_SOURCES: readonly ValidSource[] = [
  'messages',
  'gmail',
  'email',
  'imessage',
  'whatsapp',
];

export function isMessageFamilySource(source: ValidSource): boolean {
  return MESSAGE_FAMILY_SOURCES.includes(source);
}

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
  sources?: string[];
  filters?: Record<string, unknown>;
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
  transaction_id?: string;
  account_id?: string;
  document_id?: string;
  source_name?: string;
}

export interface GrepMatch {
  source: ValidSource;
  path: string;
  pointer: string;
  timestamp: string;
  role?: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  location: GrepLocation;
  content: string;
  records?: GrepMessageRecord[];
}

export interface GrepMessageRecord {
  message_id: string;
  channel: string;
  from: string;
  to: string;
  timestamp: string;
  message: string;
  relation: 'before' | 'match' | 'after';
}

export interface GrepResult {
  matches: GrepMatch[];
  total_matches: number;
  truncated: boolean;
  pattern: string;
  sources: ValidSource[];
  applied_limit: number;
  applied_offset: number;
  returned: number;
  has_more: boolean;
  next_offset: number | null;
  display_order: 'oldest_first' | 'newest_first';
  context_unit: 'message_record' | 'logical_line' | 'mixed';
  summaries?: Partial<Record<ValidSource, unknown>>;
  message?: string;
}

export interface TransactionGrepFilters {
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals: boolean;
}

export interface DocumentGrepFilters {
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  tag?: string;
}

export interface MessageGrepFilters {
  person?: string;
  since?: Date;
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
  filters: {
    messages?: MessageGrepFilters;
    transactions?: TransactionGrepFilters;
    documents?: DocumentGrepFilters;
  };
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
    transactions?: {
      total_transactions: number;
      account_count: number;
      institutions: string[];
      date_range: {
        from: string | null;
        to: string | null;
      };
    };
    documents?: {
      total_documents: number;
      sources: Record<string, number>;
      date_range: {
        from: string | null;
        to: string | null;
      };
    };
  };
}
