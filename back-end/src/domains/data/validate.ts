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
} from './validate.filters';
import {
  parseAgentNetworkFilters,
  parseAgentTrajectoryFilters,
  parseAgentPaging,
  validateAgentSourceSelection,
} from './validate.agent';
import { parseGoogleSourceFilters } from './validate.google';
import {
  dropNullParams,
  filtersBySource,
  sentParamFor,
  sharedFilters,
  sourcesNamedByFilters,
  splitFilters,
  type SplitFilters,
} from './validate.normalize';

function databaseRegexPattern(pattern: string, multiline: boolean): string {
  if (!multiline) return pattern;
  return pattern.replace(/(?<!\\)\.\*/g, '(.|\n)*').replace(/(?<!\\)\.\+/g, '(.|\n)+');
}

interface ResolvedSourceSelection {
  resolvedSources: ValidSource[];
  /** No pattern means "list": agent sources, or only calendar/drive. */
  patternOptional: boolean;
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
  // Narrowing shorthands applied to every selected source that accepts them.
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

function hasTrajectoryNarrowing(params: GrepParams, split: SplitFilters): boolean {
  const { flat } = split;
  return (
    params.role !== undefined ||
    params.record_kind !== undefined ||
    params.surface !== undefined ||
    params.trace_path !== undefined ||
    params.until !== undefined ||
    params.order !== undefined ||
    params.page_after !== undefined ||
    ['role', 'record_kind', 'surface'].some((key) => key in flat) ||
    (typeof flat.path === 'string' && flat.path.startsWith('agent_trajectories/'))
  );
}

function requireKnownSources(params: GrepParams): void {
  const { source, sources } = params;
  if (source !== undefined && !(source in VALID_SOURCES)) {
    throw new SourceNotFoundError(source);
  }
  if (sources === undefined) return;
  if (!Array.isArray(sources)) {
    throw new InvalidGrepParamError('sources', 'sources must be a list such as ["messages"].');
  }
  for (const entry of sources) {
    if (typeof entry !== 'string' || !(entry in VALID_SOURCES)) {
      throw new SourceNotFoundError(typeof entry === 'string' ? entry : String(entry));
    }
  }
}

/**
 * Sources in precedence order: explicit `sources`/`source`; sources the
 * filters name (a nested block or a printed path); typed trajectory narrowing;
 * otherwise the local defaults. Flat filters then apply as they do to any
 * selection (validate.normalize.ts).
 */
function resolveSourceSelection(params: GrepParams, split: SplitFilters): ResolvedSourceSelection {
  requireKnownSources(params);
  const { source, sources } = params;
  const named = sourcesNamedByFilters(split);
  const resolvedSources: ValidSource[] =
    sources !== undefined
      ? [...new Set(sources as ValidSource[])]
      : source !== undefined
        ? [source as ValidSource]
        : named.length > 0
          ? named
          : hasTrajectoryNarrowing(params, split)
            ? ['agent_trajectories']
            : DEFAULT_GREP_SOURCES;
  validateAgentSourceSelection(params, resolvedSources);
  return {
    resolvedSources,
    patternOptional:
      resolvedSources.includes('agent_trajectories') ||
      resolvedSources.includes('agent_network') ||
      resolvedSources.every(isGoogleGrepSource),
  };
}

/** Parse each source's filters, reporting a bad value under the name the caller sent. */
function parseSourceFilters(
  params: GrepParams,
  split: SplitFilters,
  sources: ValidSource[]
): ValidatedGrepInput['filters'] {
  try {
    return parseEachSourceFilters(params, split, sources);
  } catch (error) {
    const key =
      error instanceof InvalidGrepParamError
        ? /^filters\.(\w+)$/.exec(error.param)?.[1]
        : undefined;
    if (error instanceof InvalidGrepParamError && key !== undefined) {
      const sent = sentParamFor(key, params, split);
      if (sent !== error.param) throw new InvalidGrepParamError(sent, error.hint);
    }
    throw error;
  }
}

function parseEachSourceFilters(
  params: GrepParams,
  split: SplitFilters,
  sources: ValidSource[]
): ValidatedGrepInput['filters'] {
  const bySource = filtersBySource(params, split, sources);
  const of = (source: ValidSource) => bySource.get(source) ?? {};
  const has = (source: ValidSource) => sources.includes(source);
  return {
    messages: sources.some(isMessageFamilySource)
      ? parseMessageFilters(sharedFilters(bySource, 'messages'))
      : undefined,
    transactions: has('transactions') ? parseTransactionFilters(of('transactions')) : undefined,
    documents: has('documents') ? parseDocumentFilters(of('documents')) : undefined,
    network: has('network') ? parseNetworkFilters(of('network')) : undefined,
    agentNetwork: has('agent_network')
      ? parseAgentNetworkFilters(params, of('agent_network'))
      : undefined,
    agentTrajectories: has('agent_trajectories')
      ? parseAgentTrajectoryFilters(params, of('agent_trajectories'))
      : undefined,
    google: sources.some(isGoogleGrepSource)
      ? parseGoogleSourceFilters(sharedFilters(bySource, 'google'), sources)
      : undefined,
  };
}

export function validateGrepInput(rawParams: GrepParams): ValidatedGrepInput {
  const params = dropNullParams(rawParams);
  for (const key of Object.keys(params)) {
    if (!ALLOWED_GREP_KEYS.has(key)) {
      throw new InvalidGrepParamError(key);
    }
  }

  const split = splitFilters(params);
  const { resolvedSources, patternOptional } = resolveSourceSelection(params, split);

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
    filters: parseSourceFilters(params, split, resolvedSources),
  };
}
