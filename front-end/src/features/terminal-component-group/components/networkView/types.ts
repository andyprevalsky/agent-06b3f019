export type SortKey =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phoneNumber'
  | 'messagesExchanged'
  | 'company'
  | 'title'
  | 'communicationFrequency';

export type SortDirection = 'asc' | 'desc';

export type SortState = { key: SortKey; direction: SortDirection } | null;

export const COLUMNS: readonly [SortKey, string][] = [
  ['firstName', 'First'],
  ['lastName', 'Last'],
  ['email', 'Email'],
  ['phoneNumber', 'Phone'],
  ['messagesExchanged', 'Messages'],
  ['company', 'Company'],
  ['title', 'Title'],
  ['communicationFrequency', 'Communication Frequency'],
];

export function formatPersonValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string' && value.length === 0) return '—';
  return String(value);
}
