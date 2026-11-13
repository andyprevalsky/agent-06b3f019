import type { getSharedDataMap } from './teamContext';
/** Grep summary response types. */
export interface SummaryThreadInfo {
  name: string;
  message_count: number;
  last_message: string;
}

export interface SummaryResult {
  teams?: Awaited<ReturnType<typeof getSharedDataMap>>;
  sources: {
    messages: {
      total_threads: number;
      total_messages: number;
      channels: Record<string, number>;
      date_range: {
        from: string | null;
        to: string | null;
      };
      latest_message: {
        timestamp: string;
        channel: string;
        from: string;
        to: string;
        text: string;
      } | null;
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
    /** Google Calendar, searched as the `calendar` source. */
    calendar?: { accounts: string[]; total_events: number };
    /** Google Drive, searched as the `drive` source. */
    drive?: { accounts: string[]; total_files: number };
  };
}
