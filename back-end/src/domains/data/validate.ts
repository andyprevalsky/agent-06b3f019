/**
 * Data domain grep input validation: param allow-listing, regex compilation +
 * ReDoS safety, and normalization into ValidatedGrepInput.
 */

import { MAX_RESULTS } from './config';
import { InvalidGrepParamError, InvalidPatternError, SourceNotFoundError } from './errors';
import { checkPatternSafety, extractInlineFlags, stripNamedGroups } from './regexSafety';
import {
  DATA_SOURCE_CONFIGS,
  DEFAULT_GREP_SOURCES,
  VALID_SOURCES,
  isMessageFamilySource,
  type DocumentGrepFilters,
  type GrepParams,
  type MessageGrepFilters,
  type TransactionGrepFilters,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';

const ALLOWED_GREP_KEYS = new Set([
  'pattern',
  'source',
  'sources',
  'filters',
  '-A',
  '-B',
  '-C',
  'context',
  '-n',
  '-i',
  'head_limit',
  'offset',
  'multiline',
  // messages-source-only narrowing.
  'person',
  'since',
  // Internal transport keys, not exposed to the model.
  'agent_id',
  'user_id',
]);

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return defaultValue;
}

function parseFilterBoolean(
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

function parseBoundedNumber(
  value: unknown,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

function databaseRegexPattern(pattern: string, multiline: boolean): string {
  if (!multiline) return pattern;
  return pattern.replace(/(?<!\\)\.\*/g, '(.|\n)*').replace(/(?<!\\)\.\+/g, '(.|\n)+');
}

/**
 * Parse the messages-only `since` cutoff. Accepts ISO 8601, or a relative form
 * like `7d` / `24h` / `30m`. Returns undefined for missing/invalid input.
 */
function parseSince(value: unknown): Date | undefined {
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

function parseFilterDate(filters: Record<string, unknown>, key: string): Date | undefined {
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

function parseFilterSince(filters: Record<string, unknown>, key: string): Date | undefined {
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

function parseFilterString(filters: Record<string, unknown>, key: string): string | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  return value.trim();
}

function parseFilterNumber(filters: Record<string, unknown>, key: string): number | undefined {
  if (!(key in filters)) return undefined;
  const value = filters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidGrepParamError(`filters.${key}`);
  }
  return value;
}

function requireFilterObject(params: GrepParams): Record<string, unknown> {
  if (params.filters === undefined || params.filters === null) return {};
  if (typeof params.filters !== 'object' || Array.isArray(params.filters)) {
    throw new InvalidGrepParamError('filters');
  }
  return params.filters;
}

function rejectUnsupportedFilters(source: ValidSource, filters: Record<string, unknown>): void {
  const allowed = new Set<string>(DATA_SOURCE_CONFIGS[source].filters);
  for (const key of Object.keys(filters)) {
    if (!allowed.has(key)) {
      throw new InvalidGrepParamError(`filters.${key}`);
    }
  }
}

function parseMessageFilters(
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
  return {
    person: parseFilterString(merged, 'person'),
    since: parseFilterSince(merged, 'since'),
  };
}

function parseTransactionFilters(params: GrepParams): TransactionGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) {
    return { includePendingInTotals: false, status: 'all' };
  }
  rejectUnsupportedFilters('transactions', raw);
  const status = 'status' in raw ? parseFilterString(raw, 'status') : 'all';
  if (status !== 'pending' && status !== 'posted' && status !== 'all') {
    throw new InvalidGrepParamError('filters.status');
  }
  return {
    since: parseFilterDate(raw, 'since'),
    until: parseFilterDate(raw, 'until'),
    account: parseFilterString(raw, 'account'),
    minAmount: parseFilterNumber(raw, 'min_amount'),
    maxAmount: parseFilterNumber(raw, 'max_amount'),
    status,
    includePendingInTotals: parseFilterBoolean(raw, 'include_pending_in_totals', false),
  };
}

function parseDocumentFilters(params: GrepParams): DocumentGrepFilters | undefined {
  const raw = requireFilterObject(params);
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('documents', raw);
  return {
    documentSource: parseFilterString(raw, 'document_source')
      ?.toLowerCase()
      .replace(/[\s-]+/g, '_'),
    since: parseFilterSince(raw, 'since'),
    until: parseFilterDate(raw, 'until'),
    path: parseFilterString(raw, 'path'),
    tag: parseFilterString(raw, 'tag'),
  };
}

interface ResolvedSourceSelection {
  resolvedSources: ValidSource[];
  hasMessageFamily: boolean;
  hasTransactions: boolean;
  hasDocuments: boolean;
  mergeTopLevelNarrowing: boolean;
}

/**
 * Validate the source selection (single `source` or multi `sources`), resolve
 * the effective list, and derive which filter families apply. Also enforces the
 * legacy filter-rejection rules so single-source behavior is unchanged.
 */
function resolveSourceSelection(params: GrepParams): ResolvedSourceSelection {
  const { source, sources } = params;
  if (source !== undefined && !(source in VALID_SOURCES)) {
    throw new SourceNotFoundError(source);
  }
  if (sources !== undefined) {
    if (!Array.isArray(sources)) {
      throw new InvalidGrepParamError('sources');
    }
    for (const entry of sources) {
      if (typeof entry !== 'string' || !(entry in VALID_SOURCES)) {
        throw new SourceNotFoundError(typeof entry === 'string' ? entry : String(entry));
      }
    }
  }

  // Explicit `sources` array (deduped) wins, then a single `source`, else the
  // default trio.
  const resolvedSources: ValidSource[] =
    sources !== undefined
      ? [...new Set(sources as ValidSource[])]
      : source !== undefined
        ? [source as ValidSource]
        : DEFAULT_GREP_SOURCES;

  if (params.filters !== undefined && source === undefined && sources === undefined) {
    throw new InvalidGrepParamError('filters');
  }

  // Single-source callers (no `sources` array): top-level `person`/`since`
  // narrowing merges into message filters only when the single source is in the
  // message family, matching historical behavior.
  const selectedSource = source as ValidSource | undefined;

  // Reject filters for a single non-filterable source (byte-identical to the
  // pre-`sources` behavior). Multi-source queries route filters by family.
  if (
    sources === undefined &&
    selectedSource !== undefined &&
    !isMessageFamilySource(selectedSource) &&
    selectedSource !== 'transactions' &&
    selectedSource !== 'documents'
  ) {
    rejectUnsupportedFilters(selectedSource, requireFilterObject(params));
  }

  return {
    resolvedSources,
    hasMessageFamily: resolvedSources.some(isMessageFamilySource),
    hasTransactions: resolvedSources.includes('transactions'),
    hasDocuments: resolvedSources.includes('documents'),
    mergeTopLevelNarrowing:
      selectedSource !== undefined && isMessageFamilySource(selectedSource),
  };
}

export function validateGrepInput(params: GrepParams): ValidatedGrepInput {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_GREP_KEYS.has(key)) {
      throw new InvalidGrepParamError(key);
    }
  }

  const { pattern } = params;
  if (pattern === undefined || pattern === null || typeof pattern !== 'string') {
    throw new InvalidPatternError();
  }

  const {
    resolvedSources,
    hasMessageFamily,
    hasTransactions,
    hasDocuments,
    mergeTopLevelNarrowing,
  } = resolveSourceSelection(params);

  const multiline = parseBoolean(params.multiline, false);
  // Fix 1: fold inline (?i) into case-insensitivity (JS RegExp + Postgres ARE reject it).
  const { pattern: normalizedPattern, caseInsensitive: inlineCaseInsensitive } =
    extractInlineFlags(pattern);
  const caseInsensitive = parseBoolean(params['-i'], false) || inlineCaseInsensitive;
  const flags = `${caseInsensitive ? 'i' : ''}${multiline ? 's' : ''}`;
  let regex: RegExp;
  try {
    regex = new RegExp(normalizedPattern, flags);
  } catch (error) {
    throw new InvalidPatternError(
      `Invalid regular expression '${pattern}': ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Fix 2: reject ReDoS-catastrophic patterns before they reach Postgres `~`.
  const safety = checkPatternSafety(normalizedPattern, flags);
  if (!safety.ok) {
    throw new InvalidPatternError(safety.reason);
  }

  const symmetricContext = params.context ?? params['-C'];
  const symmetric =
    symmetricContext !== undefined ? parseBoundedNumber(symmetricContext, 0, 0, 25) : undefined;
  const contextBefore =
    symmetric !== undefined ? symmetric : parseBoundedNumber(params['-B'], 0, 0, 25);
  const contextAfter =
    symmetric !== undefined ? symmetric : parseBoundedNumber(params['-A'], 0, 0, 25);

  return {
    pattern,
    // Strip named-capture syntax for Postgres ARE (we only boolean-match).
    dbPattern: databaseRegexPattern(stripNamedGroups(normalizedPattern), multiline),
    sources: resolvedSources,
    regex,
    caseInsensitive,
    multiline,
    showLineNumbers: parseBoolean(params['-n'], true),
    contextBefore,
    contextAfter,
    headLimit: parseBoundedNumber(params.head_limit, 20, 1, MAX_RESULTS),
    offset: parseBoundedNumber(params.offset, 0, 0, 10_000),
    filters: {
      messages: hasMessageFamily ? parseMessageFilters(params, mergeTopLevelNarrowing) : undefined,
      transactions: hasTransactions ? parseTransactionFilters(params) : undefined,
      documents: hasDocuments ? parseDocumentFilters(params) : undefined,
    },
  };
}
