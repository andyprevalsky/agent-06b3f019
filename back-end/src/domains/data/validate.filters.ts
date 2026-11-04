/**
 * Per-source grep filter parsing.
 *
 * Split out of validate.ts: each source owns a distinct filter key set
 * (DATA_SOURCE_CONFIGS in types.ts), and `filters.path` translates an emitted
 * path back into structured components for every source that emits one. Each
 * parser receives that source's effective filters (validate.normalize.ts), so
 * key placement is already settled and only values are checked here.
 */

import { InvalidGrepParamError } from './errors';
import { parseGrepPath } from './path';
import type {
  DocumentGrepFilters,
  MessageGrepFilters,
  NetworkGrepFilters,
  TransactionGrepFilters,
  ValidSource,
} from './types';

export type FilterObject = Record<string, unknown>;

const SINCE_HINT = 'Use an ISO 8601 time or a relative form like 7d, 24h or 30m.';
const DATE_HINT = 'Use an ISO 8601 date or time, such as 2026-11-02.';

/** Why a `filters.path` value was refused, and what it accepts. */
export function printedPathHint(source: ValidSource): string {
  const agentAddress =
    source === 'agent_network' || source === 'agent_trajectories'
      ? ' or an agent address in your tree such as /root/outreach'
      : '';
  return `It must be a path an earlier ${source} result printed (${source}/...)${agentAddress}.`;
}

export function parseFilterBoolean(
  filters: Record<string, unknown>,
  key: string,
  defaultValue: boolean
): boolean {
  if (!(key in filters)) return defaultValue;
  if (typeof filters[key] !== 'boolean') {
    throw new InvalidGrepParamError(`filters.${key}`, 'It must be true or false.');
  }
  return filters[key];
}

export function parseBoundedNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

export function parseSince(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const relative = value.trim().match(/^(\d+)\s*([dhm])$/i);
  if (relative !== null) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const unitMs = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000;
    return new Date(Date.now() - amount * unitMs);
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Parse the messages-only `since` cutoff. Accepts ISO 8601, or a relative form
 * like `7d` / `24h` / `30m`. Returns undefined for missing/invalid input.
 */

export function parseFilterDate(filters: Record<string, unknown>, key: string): Date | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidGrepParamError(`filters.${key}`, DATE_HINT);
  }
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidGrepParamError(`filters.${key}`, DATE_HINT);
  }
  return parsed;
}

export function parseFilterSince(filters: Record<string, unknown>, key: string): Date | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidGrepParamError(`filters.${key}`, SINCE_HINT);
  }
  const parsed = parseSince(value);
  if (parsed === undefined) {
    throw new InvalidGrepParamError(`filters.${key}`, SINCE_HINT);
  }
  return parsed;
}

export function parseFilterString(
  filters: Record<string, unknown>,
  key: string
): string | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidGrepParamError(`filters.${key}`, 'It must be a non-empty string.');
  }
  return value.trim();
}

export function parseFilterNumber(
  filters: Record<string, unknown>,
  key: string
): number | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidGrepParamError(`filters.${key}`, 'It must be a number.');
  }
  return value;
}

export function parseMessageFilters(merged: FilterObject): MessageGrepFilters | undefined {
  if (Object.keys(merged).length === 0) return undefined;
  const rawPath = parseFilterString(merged, 'path');
  const parsedPath = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  // A path grep printed for another source (or a non-path string) is a caller
  // error, not an empty result — fail loudly the way an unknown key does.
  if (
    rawPath !== undefined &&
    (parsedPath === null || parsedPath === undefined || parsedPath.source !== 'messages')
  ) {
    throw new InvalidGrepParamError('filters.path', printedPathHint('messages'));
  }
  return {
    person: parseFilterString(merged, 'person'),
    since: parseFilterSince(merged, 'since'),
    ...(parsedPath?.source === 'messages'
      ? {
          pathThread: parsedPath.thread,
          ...(parsedPath.messageId !== undefined ? { pathMessageId: parsedPath.messageId } : {}),
        }
      : {}),
  };
}

export function parseNetworkFilters(raw: FilterObject): NetworkGrepFilters | undefined {
  const rawPath = parseFilterString(raw, 'path');
  if (rawPath === undefined) return undefined;
  const parsed = parseGrepPath(rawPath);
  if (parsed === null || parsed.source !== 'network') {
    throw new InvalidGrepParamError('filters.path', printedPathHint('network'));
  }
  return { pathContact: parsed.contact };
}

export function parseTransactionFilters(raw: FilterObject): TransactionGrepFilters | undefined {
  if (Object.keys(raw).length === 0) {
    return { includePendingInTotals: false, status: 'all' };
  }
  const rawPath = parseFilterString(raw, 'path');
  const parsedPath = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  if (rawPath !== undefined && (parsedPath === null || parsedPath?.source !== 'transactions')) {
    throw new InvalidGrepParamError('filters.path', printedPathHint('transactions'));
  }
  const status = 'status' in raw ? parseFilterString(raw, 'status') : 'all';
  if (status !== 'pending' && status !== 'posted' && status !== 'all') {
    throw new InvalidGrepParamError('filters.status', 'Use posted, pending or all.');
  }
  return {
    ...(parsedPath?.source === 'transactions'
      ? {
          ...(parsedPath.institution !== undefined
            ? { pathInstitution: parsedPath.institution }
            : {}),
          ...(parsedPath.account !== undefined ? { pathAccount: parsedPath.account } : {}),
          ...(parsedPath.transactionId !== undefined
            ? { pathTransactionId: parsedPath.transactionId }
            : {}),
        }
      : {}),
    since: parseFilterDate(raw, 'since'),
    until: parseFilterDate(raw, 'until'),
    account: parseFilterString(raw, 'account'),
    minAmount: parseFilterNumber(raw, 'min_amount'),
    maxAmount: parseFilterNumber(raw, 'max_amount'),
    status,
    includePendingInTotals: parseFilterBoolean(raw, 'include_pending_in_totals', false),
  };
}

export function documentPathFilters(rawPath: string | undefined): {
  path?: string;
  pathDocumentSource?: string;
  pathRest?: string;
} {
  if (rawPath === undefined) return {};
  const parsed = parseGrepPath(rawPath);
  if (parsed === null) return { path: rawPath };
  if (parsed.source !== 'documents') {
    throw new InvalidGrepParamError('filters.path', printedPathHint('documents'));
  }
  return {
    ...(parsed.documentSource !== undefined ? { pathDocumentSource: parsed.documentSource } : {}),
    ...(parsed.rest !== undefined ? { pathRest: parsed.rest } : {}),
  };
}

export function parseDocumentFilters(raw: FilterObject): DocumentGrepFilters | undefined {
  if (Object.keys(raw).length === 0) return undefined;
  return {
    documentSource: parseFilterString(raw, 'document_source')
      ?.toLowerCase()
      .replace(/[\s-]+/g, '_'),
    since: parseFilterSince(raw, 'since'),
    until: parseFilterDate(raw, 'until'),
    // A value this tool printed (`documents/<source>/...`) addresses that record;
    // anything else keeps the original free-text substring behavior over
    // externalId/title/url/metadata.
    ...documentPathFilters(parseFilterString(raw, 'path')),
    tag: parseFilterString(raw, 'tag'),
  };
}
