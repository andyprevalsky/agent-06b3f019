/**
 * Bridge exposing the data domain's grep to providers (SMS supervisor).
 *
 * Providers must not import domains (structural invariant 3, layer-deps),
 * so server.ts registers `grep` from domains/data/service here at boot and
 * provider code calls through this slot. Types below are structural mirrors
 * of the domain's GrepParams/GrepResult — kept import-free on purpose.
 */

export interface UserDataGrepParams {
  pattern?: string;
  source?: string;
  sources?: string[];
  agent_id?: string;
  filters?: Record<string, unknown>;
  role?: string;
  record_kind?: string;
  surface?: string;
  trace_path?: string;
  until?: string;
  order?: 'newest_first' | 'oldest_first';
  page_after?: string;
  '-A'?: string | number;
  '-B'?: string | number;
  '-C'?: string | number;
  context?: string | number;
  '-n'?: boolean | string;
  '-i'?: boolean | string;
  head_limit?: string | number;
  offset?: string | number;
  multiline?: boolean | string;
  person?: string;
  since?: string;
}

export interface UserDataGrepMatch {
  source: string;
  path: string;
  pointer: string;
  timestamp: string;
  role?: string;
  line_numbers?: boolean;
  content: string;
  records?: Array<{
    message_id: string;
    channel: string;
    from: string;
    to: string;
    timestamp: string;
    message: string;
    relation: 'before' | 'match' | 'after';
  }>;
}

export interface UserDataGrepResult {
  matches: UserDataGrepMatch[];
  total_matches: number;
  truncated: boolean;
  pattern: string;
  sources: string[];
  applied_limit: number;
  applied_offset: number;
  returned: number;
  has_more: boolean;
  next_offset: number | null;
  next_page_after?: string | null;
  display_order: 'oldest_first' | 'newest_first';
  context_unit: 'message_record' | 'logical_line' | 'mixed';
  summaries?: Partial<Record<string, unknown>>;
  message?: string;
}

type UserDataGrepFn = (userId: string, params: UserDataGrepParams) => Promise<UserDataGrepResult>;

let grepExecutor: UserDataGrepFn | null = null;

export function registerUserDataGrep(fn: UserDataGrepFn): void {
  grepExecutor = fn;
}

export async function executeUserDataGrep(
  userId: string,
  params: UserDataGrepParams
): Promise<UserDataGrepResult> {
  if (grepExecutor === null) {
    throw new Error(
      '[UserDataSearch] user data grep not initialized — registerUserDataGrep was never called'
    );
  }
  return grepExecutor(userId, params);
}

let summaryExecutor: ((userId: string) => Promise<unknown>) | null = null;

export function registerUserDataSummary(fn: (userId: string) => Promise<unknown>): void {
  summaryExecutor = fn;
}

export function executeUserDataSummary(userId: string): Promise<unknown> {
  if (!summaryExecutor) throw new Error('[UserDataSearch] user data summary not initialized');
  return summaryExecutor(userId);
}
