/**
 * Data domain grep input validation: param allow-listing, regex compilation +
 * ReDoS safety, and normalization into ValidatedGrepInput.
 */

import { MAX_RESULTS } from './config';
import { InvalidGrepParamError, InvalidPatternError, SourceNotFoundError } from './errors';
import { checkPatternSafety, extractInlineFlags, stripNamedGroups } from './regexSafety';
import {
  parseBoundedNumber,
  parseDocumentFilters,
  parseMessageFilters,
  parseNetworkFilters,
  parseTransactionFilters,
  rejectUnsupportedFilters,
  requireFilterObject,
} from './validate.filters';
import { parseAgentNetworkFilters, parseAgentTrajectoryFilters } from './validate.agent';

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
  mergeTopLevelNarrowing: boolean;
}
import {
  DEFAULT_GREP_SOURCES,
  VALID_SOURCES,
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

function resolveSourceSelection(params: GrepParams): ResolvedSourceSelection {
  const { source, sources } = params;
  const rawFilters = requireFilterObject(params);
  const trajectoryNarrowing =
    params.role !== undefined ||
    params.record_kind !== undefined ||
    params.surface !== undefined ||
    params.trace_path !== undefined ||
    params.until !== undefined ||
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

  // Typed trajectory narrowing chooses its source when the caller omits one.
  const resolvedSources: ValidSource[] =
    sources !== undefined
      ? [...new Set(sources as ValidSource[])]
      : source !== undefined
        ? [source as ValidSource]
        : trajectoryNarrowing
          ? ['agent_trajectories']
          : DEFAULT_GREP_SOURCES;

  if (
    params.filters !== undefined &&
    source === undefined &&
    sources === undefined &&
    !trajectoryNarrowing
  ) {
    throw new InvalidGrepParamError('filters');
  }

  const hasMessageFamily = resolvedSources.some(isMessageFamilySource);
  const hasTransactions = resolvedSources.includes('transactions');
  const hasDocuments = resolvedSources.includes('documents');
  const hasNetwork = resolvedSources.includes('network');
  const hasAgentNetwork = resolvedSources.includes('agent_network');
  const hasAgentTrajectories = resolvedSources.includes('agent_trajectories');
  if (
    !hasAgentTrajectories &&
    (params.record_kind !== undefined ||
      params.surface !== undefined ||
      params.trace_path !== undefined ||
      params.until !== undefined)
  ) {
    throw new InvalidGrepParamError('agent_trajectories source');
  }
  if (params.role !== undefined && !hasAgentTrajectories && !hasAgentNetwork) {
    throw new InvalidGrepParamError('role');
  }

  // Reject filters that NO resolved source can consume. Message/transaction/
  // document families reject unsupported keys inside their own parse step; the
  // gap is a purely-local selection (e.g. sources=['network']) where none of
  // those parsers run — without this the filters would be silently dropped.
  // Covers both the single-source (byte-identical to pre-`sources` behavior when
  // resolvedSources===[selectedSource]) and the multi-source path.
  const filterObj = rawFilters;
  if (Object.keys(filterObj).length > 0 && !hasMessageFamily && !hasTransactions && !hasDocuments) {
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
    mergeTopLevelNarrowing,
  } = resolveSourceSelection(params);

  const pattern =
    params.pattern === undefined
      ? hasAgentTrajectories || hasAgentNetwork
        ? ''
        : undefined
      : params.pattern;
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
      network: hasNetwork ? parseNetworkFilters(params) : undefined,
      agentNetwork: hasAgentNetwork ? parseAgentNetworkFilters(params) : undefined,
      agentTrajectories: hasAgentTrajectories ? parseAgentTrajectoryFilters(params) : undefined,
    },
  };
}
