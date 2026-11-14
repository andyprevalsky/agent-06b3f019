export interface GrepOwnership {
  owner_user_id: string;
  owner_name: string | null;
  provider: string;
  account_id: string | null;
  shared: boolean;
  team_ids: string[];
}

export interface GrepMessageRecord {
  owner_user_id?: string;
  account_id?: string | null;
  message_id: string;
  channel: string;
  from: string;
  to: string;
  timestamp: string;
  message: string;
  relation: 'before' | 'match' | 'after';
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
