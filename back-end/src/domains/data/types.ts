import type {
  AgentMetadataParams,
  AgentNetworkGrepFilters,
  AgentTrajectoryGrepFilters,
} from './types.agent';
export type { AgentNetworkGrepFilters, AgentTrajectoryGrepFilters } from './types.agent';

export const DATA_SOURCE_CONFIGS = {
  messages: {
    description: 'iMessage and email conversation threads (all channels)',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since', 'path'] as const,
    // Umbrella source: no connector requirement, no channel restriction.
    connector: null,
    channel: null,
  },
  gmail: {
    description: 'Gmail/email conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since', 'path'] as const,
    // Alias of `email`; kept for backward compatibility.
    connector: 'gmail',
    channel: 'EMAIL',
  },
  email: {
    description: 'Email conversation threads (Gmail-connected)',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since', 'path'] as const,
    connector: 'gmail',
    channel: 'EMAIL',
  },
  imessage: {
    description: 'iMessage conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since', 'path'] as const,
    connector: 'imessage',
    channel: 'IMESSAGE',
  },
  whatsapp: {
    description: 'WhatsApp conversation threads',
    table: 'MessageRecord' as const,
    searchField: 'message',
    groupBy: 'personId',
    filters: ['person', 'since', 'path'] as const,
    connector: 'whatsapp',
    channel: 'WHATSAPP',
  },
  network: {
    description: 'Contact network records',
    table: 'Person' as const,
    searchField: 'contact fields',
    groupBy: 'personId',
    filters: ['path'] as const,
    connector: null,
    channel: null,
  },
  agent_network: {
    description: 'Messages across the current agent tree',
    table: 'Message' as const,
    searchField: 'text',
    groupBy: 'agentId',
    filters: ['path', 'role'] as const,
    connector: null,
    channel: null,
  },
  agent_trajectories: {
    description: 'User-owned agent runs outside the current agent tree',
    table: 'AgentTrajectorySearch' as const,
    searchField: 'searchText',
    groupBy: 'rootAgentId',
    filters: ['path', 'since', 'until', 'role', 'surface', 'record_kind'] as const,
    connector: null,
    channel: null,
  },
  transactions: {
    description: 'Plaid financial transactions',
    table: 'PlaidTransaction' as const,
    searchField: 'transaction fields',
    groupBy: 'plaidAccountId',
    filters: [
      'path',
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
  calendar: {
    description: 'Google Calendar events on the primary calendar',
    table: 'UserDataDocument' as const,
    searchField: 'title/path/details',
    groupBy: 'googleAccountEmail',
    filters: ['since', 'until', 'path'] as const,
    // Shares the Google connection that `email` uses.
    connector: 'gmail',
    channel: null,
  },
  drive: {
    description: 'Google Drive files and folders',
    table: 'UserDataDocument' as const,
    searchField: 'title/path/text',
    groupBy: 'googleAccountEmail',
    filters: ['since', 'until', 'path'] as const,
    connector: 'gmail',
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

/** Sources backed by Google rows in the document store, refreshed on read. */
export type GoogleGrepSource = 'calendar' | 'drive';

export function isGoogleGrepSource(source: ValidSource): source is GoogleGrepSource {
  return source === 'calendar' || source === 'drive';
}

/** A search over calendar alone reads forward in time; any mix is newest first. */
export function isCalendarOnly(sources: readonly ValidSource[]): boolean {
  return sources.length > 0 && sources.every((source) => source === 'calendar');
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

export interface GrepParams extends AgentMetadataParams {
  pattern?: string;
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
  /** The agent's task path (/root/...) when known. */
  agent_path?: string;
  root_agent_id?: string;
  surface?: string;
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
  next_page_after?: string | null;
  display_order: 'oldest_first' | 'newest_first';
  context_unit: 'message_record' | 'logical_line' | 'mixed';
  summaries?: Partial<Record<ValidSource, unknown>>;
  message?: string;
}

export interface TransactionGrepFilters {
  /** Parsed from `filters.path` — addresses an institution/account/transaction subtree. */
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals: boolean;
}

export interface DocumentGrepFilters {
  /** Set when `filters.path` was a path this tool printed. */
  pathDocumentSource?: string;
  pathRest?: string;
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  tag?: string;
}

/**
 * `calendar` and `drive` narrowing. A date-only `since`/`until` on calendar is
 * compared with the event's own local date, so `until: 2026-10-02` includes
 * that whole day wherever the event is.
 */
export interface GoogleSourceGrepFilters {
  since?: Date;
  until?: Date;
  sinceDate?: string;
  untilDate?: string;
  /** Which source the printed `filters.path` belongs to. */
  pathSource?: GoogleGrepSource;
  /** Folder or record path below the source root, as grep printed it. */
  pathPrefix?: string;
}

export interface MessageGrepFilters {
  person?: string;
  since?: Date;
  /** Parsed from `filters.path` — addresses one thread, optionally one message. */
  pathThread?: string;
  pathMessageId?: string;
}

/** `network` narrowing. `path` addresses one contact record. */
export interface NetworkGrepFilters {
  pathContact?: string;
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
  order: 'newest_first' | 'oldest_first';
  pageAfterMessageId?: string;
  pageAfterPath?: string;
  filters: {
    messages?: MessageGrepFilters;
    network?: NetworkGrepFilters;
    agentNetwork?: AgentNetworkGrepFilters;
    agentTrajectories?: AgentTrajectoryGrepFilters;
    transactions?: TransactionGrepFilters;
    documents?: DocumentGrepFilters;
    google?: GoogleSourceGrepFilters;
  };
}

export type { SummaryResult, SummaryThreadInfo } from './types.summary';
