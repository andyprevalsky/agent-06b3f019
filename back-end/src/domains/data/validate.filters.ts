/**
 * Per-source grep filter parsing.
 *
 * Split out of validate.ts: each source owns a distinct filter key set
 * (DATA_SOURCE_CONFIGS in types.ts), and `filters.path` translates an emitted
 * path back into structured components for every source that emits one.
 */

import { InvalidGrepParamError } from './errors';
import { parseGrepPath } from './path';
import {
  DATA_SOURCE_CONFIGS,
  type AgentNetworkGrepFilters,
  type DocumentGrepFilters,
  type GrepParams,
  type MessageGrepFilters,
  type NetworkGrepFilters,
  type TransactionGrepFilters,
  type ValidSource,
} from './types';

export function parseFilterBoolean(
  filters: Record<string, unknown>,
  key: string,
  defaultValue: boolean
): boolean {
  if (!(key in filters)) return defaultValue;
  if (typeof filters[key] !== 'boolean') {
    throw new InvalidGrepParamError(`filters.${key}`);
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
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  return parsed;
}

export function parseFilterSince(filters: Record<string, unknown>, key: string): Date | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  const parsed = parseSince(value);
  if (parsed === undefined) {
    throw new InvalidGrepParamError(`filters.${key}`);
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
    throw new InvalidGrepParamError(`filters.${key}`);
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
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  return value;
}

export function requireFilterObject(params: GrepParams): Record<string, unknown> {
  if (params.filters === undefined || params.filters === null) return {};
  if (typeof params.filters !== 'object' || Array.isArray(params.filters)) {
    throw new InvalidGrepParamError('filters');
  }
  return params.filters;
}

export function rejectUnsupportedFilters(
  source: ValidSource,
  filters: Record<string, unknown>
): void {
  const allowed = new Set<string>(DATA_SOURCE_CONFIGS[source].filters);
  for (const key of Object.keys(filters)) {
    if (!allowed.has(key)) {
      throw new InvalidGrepParamError(`filters.${key}`);
    }
  }
}

export function parseMessageFilters(
  params: GrepParams,
  mergeTopLevelNarrowing: boolean
): MessageGrepFilters | undefined {
  const raw = requireFilterObject(params);
  const merged = mergeTopLevelNarrowing
    ? {
        ...raw,
        ...(params.person !== undefined ? { person: params.person } : {}),
        ...(params.since !== undefined ? { since: params.since } : {}),
      }
    : raw;
  if (Object.keys(merged).length === 0) return undefined;
  rejectUnsupportedFilters('messages', merged);
  const rawPath = parseFilterString(merged, 'path');
  const parsedPath = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  // A path grep printed for another source (or a non-path string) is a caller
  // error, not an empty result — fail loudly the way an unknown key does.
  if (
    rawPath !== undefined &&
    (parsedPath === null || parsedPath === undefined || parsedPath.source !== 'messages')
  ) {
    throw new InvalidGrepParamError('filters.path');
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

export function parseAgentNetworkFilters(params: GrepParams): AgentNetworkGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('agent_network', raw);
  const rawPath = parseFilterString(raw, 'path');
  if (rawPath === undefined) return undefined;
  const parsed = parseGrepPath(rawPath);
  if (parsed === null || parsed.source !== 'agent_network') {
    throw new InvalidGrepParamError('filters.path');
  }
  return {
    ...(parsed.agentId !== undefined ? { pathAgentId: parsed.agentId } : {}),
    ...(parsed.role !== undefined ? { pathRole: parsed.role } : {}),
    ...(parsed.messageId !== undefined ? { pathMessageId: parsed.messageId } : {}),
  };
}

export function parseNetworkFilters(params: GrepParams): NetworkGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('network', raw);
  const rawPath = parseFilterString(raw, 'path');
  if (rawPath === undefined) return undefined;
  const parsed = parseGrepPath(rawPath);
  if (parsed === null || parsed.source !== 'network') {
    throw new InvalidGrepParamError('filters.path');
  }
  return { pathContact: parsed.contact };
}

export function parseTransactionFilters(params: GrepParams): TransactionGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) {
    return { includePendingInTotals: false, status: 'all' };
  }
  rejectUnsupportedFilters('transactions', raw);
  const rawPath = parseFilterString(raw, 'path');
  const parsedPath = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  if (rawPath !== undefined && (parsedPath === null || parsedPath?.source !== 'transactions')) {
    throw new InvalidGrepParamError('filters.path');
  }
  const status = 'status' in raw ? parseFilterString(raw, 'status') : 'all';
  if (status !== 'pending' && status !== 'posted' && status !== 'all') {
    throw new InvalidGrepParamError('filters.status');
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
  if (parsed.source !== 'documents') throw new InvalidGrepParamError('filters.path');
  return {
    ...(parsed.documentSource !== undefined ? { pathDocumentSource: parsed.documentSource } : {}),
    ...(parsed.rest !== undefined ? { pathRest: parsed.rest } : {}),
  };
}

export function parseDocumentFilters(params: GrepParams): DocumentGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('documents', raw);
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

/**
 * Validate the source selection (single `source` or multi `sources`), resolve
 * the effective list, and derive which filter families apply. Also enforces the
 * legacy filter-rejection rules so single-source behavior is unchanged.
 */
