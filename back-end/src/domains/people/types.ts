/**
 * People domain types — Zod schemas, interfaces, type aliases.
 */

/**
 * Allowed sort columns for the people list endpoint.
 * Maps query param names to quoted Postgres column identifiers (prevents SQL injection).
 */
export const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  firstName: '"firstName"',
  lastName: '"lastName"',
  email: '"email"',
  phoneNumber: '"phoneNumber"',
  messagesExchanged: '"messagesExchanged"',
  company: '"company"',
  title: '"title"',
  communicationFrequency: '"communicationFrequency"',
};

export interface FormattedMessage {
  channel: string;
  from: string;
  to: string;
  timestamp: string;
  message: string;
}

export interface PersonMatch {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  email: string | null;
  messageCount: number;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
