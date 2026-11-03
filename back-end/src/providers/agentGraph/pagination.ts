/** Bounded account navigation. Cursors bind the query and snapshot; text is recoverable. */
import { createHash } from 'node:crypto';

export const ACCOUNT_PAGE_BYTES = 64 * 1024;
export const ACCOUNT_LIST_DEFAULT = 20;
export const ACCOUNT_READ_DEFAULT = 30;
export const ACCOUNT_MAX_LIMIT = 100;
export const MESSAGE_SEGMENT_CHARS = 4000;

export interface AccountCursor {
  v: 1;
  query: string;
  snapshot: string;
  at?: string;
  id?: string;
  offset?: number;
}

export function queryIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function encodeAccountCursor(value: AccountCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeAccountCursor(raw: string | undefined, query: string): AccountCursor {
  if (raw === undefined) return { v: 1, query, snapshot: new Date().toISOString() };
  try {
    if (raw.length > 2048) throw new Error();
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as AccountCursor;
    if (c.v !== 1 || c.query !== query || !Number.isFinite(Date.parse(c.snapshot)))
      throw new Error();
    if ((c.at === undefined) !== (c.id === undefined)) throw new Error();
    if (c.at !== undefined && (!Number.isFinite(Date.parse(c.at)) || typeof c.id !== 'string'))
      throw new Error();
    if (c.offset !== undefined && (!Number.isSafeInteger(c.offset) || c.offset < 0))
      throw new Error();
    return c;
  } catch {
    throw new Error('Invalid cursor for this account, query or agent');
  }
}

export function pageLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > ACCOUNT_MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${ACCOUNT_MAX_LIMIT}`);
  }
  return n;
}

export function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
