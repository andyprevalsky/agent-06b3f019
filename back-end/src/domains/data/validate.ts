/**
 * Data domain grep input validation: param allow-listing, regex compilation +
 * ReDoS safety, and normalization into ValidatedGrepInput.
 */

import { MAX_RESULTS } from './config';
import { InvalidGrepParamError, InvalidPatternError, SourceNotFoundError } from './errors';
import {
  checkPatternSafety,
  extractInlineFlags,
  stripNamedGroups,
  translateWordBoundaries,
} from './regexSafety';
import {
  parseBoundedNumber,
  parseDocumentFilters,
  parseMessageFilters,
  parseNetworkFilters,
  parseTransactionFilters,
  rejectUnsupportedFilters,
  requireFilterObject,
} from './validate.filters';
import {
  parseAgentNetworkFilters,
  parseAgentTrajectoryFilters,
  parseAgentPaging,
} from './validate.agent';
import { googleSourceOfPath, parseGoogleSourceFilters } from './validate.google';
import { agentTaskPathParam } from './path';

function databaseRegexPattern(pattern: string, multiline: boolean): string {
  if (!multiline) return pattern;
  return pattern.replace(/(?<!\\)\.\*/g, '(.|\n)*').replace(/(?<!\\)\.\+/g, '(.|\n)+');
}

interface ResolvedSourceSelection {
  resolvedSources: ValidSource[];
  hasMessageFamily: boolean;
  hasTransactions: boolean;
  hasDocuments: boolean;
  hasNetwork: boolean;
  hasAgentNetwork: boolean;
  hasAgentTrajectories: boolean;
  hasGoogle: boolean;
  /** No pattern means "list": agent sources, or only calendar/drive. */
  patternOptional: boolean;
  mergeTopLevelNarrowing: boolean;
}
import {
  DEFAULT_GREP_SOURCES,
  VALID_SOURCES,
  isGoogleGrepSource,
  isMessageFamilySource,
  type GrepParams,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';

const ALLOWED_GREP_KEYS = new Set([
  'pattern',
  'source',
  'sources',
  'filters',
  'role',
  'record_kind',
  'surface',
  'trace_path',
  'until',
  'order',
  'page_after',
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

/** agent_network rows are stored messages, so these kinds select all of them. */
const AGENT_NETWORK_RECORD_KINDS = new Set(['message', 'all']);

/**
 * Trajectory selectors on an agent_network-only search. agent_network reads the
 * stored messages of the caller's tree: an agent task path scopes it, the
 * message/all kinds select every row, and order reads it in either direction.
 * Anything else names itself, so the caller can drop that one parameter.
 */
function validateAgentNetworkSelectors(params: GrepParams, sources: ValidSource[]): void {
  if (
    params.record_kind !== undefined &&
    !AGENT_NETWORK_RECORD_KINDS.has(String(params.record_kind).toLowerCase())
  ) {
    throw new InvalidGrepParamError('record_kind');
  }
  if (params.trace_path !== undefined && agentTaskPathParam(params.trace_path) === undefined) {
    throw new InvalidGrepParamError('trace_path');
  }
  for (const key of ['surface', 'until', 'page_after'] as const) {
    if (params[key] !== undefined) throw new InvalidGrepParamError(key);
  }
  if (params.order !== undefined && sources.length !== 1) {
    throw new InvalidGrepParamError('order/page_after');
  }
}

function validateAgentSourceSelection(params: GrepParams, sources: ValidSource[]): void {
  const hasTrajectories = sources.includes('agent_trajectories');
  if (!hasTrajectories && sources.includes('agent_network')) {
    validateAgentNetworkSelectors(params, sources);
    return;
  }
  if (
    !hasTrajectories &&
    [
      params.record_kind,
      params.surface,
      params.trace_path,
      params.until,
      params.order,
      params.page_after,
    ].some((value) => value !== undefined)
  ) {
    throw new InvalidGrepParamError('agent_trajectories source');
  }
  if (params.role !== undefined && !hasTrajectories) {
    throw new InvalidGrepParamError('role');
  }
  if (
    (params.order !== undefined || params.page_after !== undefined) &&
    (sources.length !== 1 || !hasTrajectories)
  ) {
    throw new InvalidGrepParamError('order/page_after');
  }
}

function resolveSourceSelection(params: GrepParams): ResolvedSourceSelection {
  const { source, sources } = params;
  const rawFilters = requireFilterObject(params);
  const trajectoryNarrowing =
    params.role !== undefined ||
    params.record_kind !== undefined ||
    params.surface !== undefined ||
    params.trace_path !== undefined ||
    params.until !== undefined ||
    params.order !== undefined ||
    params.page_after !== undefined ||
    ['role', 'record_kind', 'surface'].some((key) => key in rawFilters) ||
    (typeof rawFilters.path === 'string' && rawFilters.path.startsWith('agent_trajectories/'));
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

  // A printed calendar or drive path names its own source, so following one
  // works without repeating the source.
  const pathSource = googleSourceOfPath(rawFilters.path);

  // Typed trajectory narrowing chooses its source when the caller omits one.
  const resolvedSources: ValidSource[] =
    sources !== undefined
      ? [...new Set(sources as ValidSource[])]
      : source !== undefined
        ? [source as ValidSource]
        : trajectoryNarrowing
          ? ['agent_trajectories']
          : pathSource !== undefined
            ? [pathSource]
            : DEFAULT_GREP_SOURCES;

  if (
    params.filters !== undefined &&
    source === undefined &&
    sources === undefined &&
    !trajectoryNarrowing &&
    pathSource === undefined
  ) {
    throw new InvalidGrepParamError('filters');
  }

  const hasMessageFamily = resolvedSources.some(isMessageFamilySource);
  const hasTransactions = resolvedSources.includes('transactions');
  const hasDocuments = resolvedSources.includes('documents');
  const hasNetwork = resolvedSources.includes('network');
  const hasAgentNetwork = resolvedSources.includes('agent_network');
  const hasAgentTrajectories = resolvedSources.includes('agent_trajectories');
  const hasGoogle = resolvedSources.some(isGoogleGrepSource);
  validateAgentSourceSelection(params, resolvedSources);

  // Reject filters that NO resolved source can consume. Message/transaction/
  // document families reject unsupported keys inside their own parse step; the
  // gap is a purely-local selection (e.g. sources=['network']) where none of
  // those parsers run — without this the filters would be silently dropped.
  // Covers both the single-source (byte-identical to pre-`sources` behavior when
  // resolvedSources===[selectedSource]) and the multi-source path.
  const filterObj = rawFilters;
  const filtersParsedBySource = hasMessageFamily || hasTransactions || hasDocuments || hasGoogle;
  if (Object.keys(filterObj).length > 0 && !filtersParsedBySource) {
    rejectUnsupportedFilters(resolvedSources[0], filterObj);
  }

  return {
    resolvedSources,
    hasMessageFamily,
    hasTransactions,
    hasDocuments,
    hasNetwork,
    hasAgentNetwork,
    hasAgentTrajectories,
    hasGoogle,
    patternOptional:
      hasAgentTrajectories || hasAgentNetwork || resolvedSources.every(isGoogleGrepSource),
    // Merge top-level `person`/`since` into message filters whenever a message-
    // family source is EXPLICITLY selected — via singular `source` OR `sources`.
    // (Not for the implicit default trio, matching historical behavior.)
    mergeTopLevelNarrowing: (source !== undefined || sources !== undefined) && hasMessageFamily,
  };
}

export function validateGrepInput(params: GrepParams): ValidatedGrepInput {
  for (const key of Object.keys(params)) {
    if (!ALLOWED_GREP_KEYS.has(key)) {
      throw new InvalidGrepParamError(key);
    }
  }

  const {
    resolvedSources,
    hasMessageFamily,
    hasTransactions,
    hasDocuments,
    hasNetwork,
    hasAgentNetwork,
    hasAgentTrajectories,
    hasGoogle,
    patternOptional,
    mergeTopLevelNarrowing,
  } = resolveSourceSelection(params);

  const agentPaging = parseAgentPaging(params);

  const pattern = params.pattern === undefined && patternOptional ? '' : params.pattern;
  if (typeof pattern !== 'string') throw new InvalidPatternError();

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
  const trajectoryDefaultAfter =
    resolvedSources.length === 1 && resolvedSources[0] === 'agent_trajectories' ? 3 : 0;
  const contextAfter =
    symmetric !== undefined
      ? symmetric
      : parseBoundedNumber(params['-A'], trajectoryDefaultAfter, 0, 25);

  return {
    pattern,
    // JS → Postgres ARE: strip named captures (we only boolean-match) and map
    // word boundaries, which ARE spells \y / \Y.
    dbPattern: databaseRegexPattern(
      translateWordBoundaries(stripNamedGroups(normalizedPattern)),
      multiline
    ),
    sources: resolvedSources,
    regex,
    caseInsensitive,
    multiline,
    showLineNumbers: parseBoolean(params['-n'], true),
    contextBefore,
    contextAfter,
    headLimit: parseBoundedNumber(params.head_limit, 20, 1, MAX_RESULTS),
    offset: parseBoundedNumber(params.offset, 0, 0, 10_000),
    ...agentPaging,
    filters: {
      messages: hasMessageFamily ? parseMessageFilters(params, mergeTopLevelNarrowing) : undefined,
      transactions: hasTransactions ? parseTransactionFilters(params) : undefined,
      documents: hasDocuments ? parseDocumentFilters(params) : undefined,
      network: hasNetwork ? parseNetworkFilters(params) : undefined,
      agentNetwork: hasAgentNetwork ? parseAgentNetworkFilters(params) : undefined,
      agentTrajectories: hasAgentTrajectories ? parseAgentTrajectoryFilters(params) : undefined,
      google: hasGoogle ? parseGoogleSourceFilters(params, resolvedSources) : undefined,
    },
  };
}
