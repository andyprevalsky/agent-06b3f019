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
  PAGE_AFTER_HINT,
} from './validate.agent';
import { parseGoogleSourceFilters } from './validate.google';
import {
  dropNullParams,
  filtersBySource,
  hasFilters,
  sharedFilters,
  sourcesNamedByFilters,
  splitFilters,
  type SplitFilters,
} from './validate.normalize';
import { agentTaskPathParam } from './path';

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

/** agent_network rows are stored messages, so these kinds select all of them. */
const AGENT_NETWORK_RECORD_KINDS = new Set(['message', 'all']);

const AGENT_SELECTOR_HINT: Record<string, string> = {
  role: 'role filters agent records; add agent_network or agent_trajectories to sources, or remove it.',
  record_kind:
    'record_kind selects agent_trajectories records; add agent_trajectories to sources, or remove it.',
  surface:
    'surface selects agent_trajectories records; add agent_trajectories to sources, or remove it.',
  trace_path:
    'trace_path scopes agent_network or agent_trajectories; add one to sources, or remove it.',
  page_after: PAGE_AFTER_HINT,
};

/**
 * Trajectory selectors on an agent_network search. agent_network reads the
 * stored messages of the caller's tree: an agent task path scopes it and the
 * message/all kinds select every row. Anything else names itself, so the
 * caller can drop that one parameter.
 */
function validateAgentNetworkSelectors(params: GrepParams): void {
  if (
    params.record_kind !== undefined &&
    !AGENT_NETWORK_RECORD_KINDS.has(String(params.record_kind).toLowerCase())
  ) {
    throw new InvalidGrepParamError(
      'record_kind',
      'agent_network holds stored messages only (message or all); model records need sources ["agent_trajectories"].'
    );
  }
  if (params.trace_path !== undefined && agentTaskPathParam(params.trace_path) === undefined) {
    throw new InvalidGrepParamError(
      'trace_path',
      'agent_network takes an agent address in your tree such as /root or /root/outreach (as list_agents prints); a trajectory UUID or agent_trajectories/... path needs sources ["agent_trajectories"].'
    );
  }
  if (params.surface !== undefined) {
    throw new InvalidGrepParamError('surface', AGENT_SELECTOR_HINT.surface);
  }
  if (params.page_after !== undefined) {
    throw new InvalidGrepParamError('page_after', AGENT_SELECTOR_HINT.page_after);
  }
}

/**
 * `order` and `page_after` page one agent_trajectories search. `order` is
 * accepted and ignored where it does not apply (display_order reports the
 * real order); a merged search with agent_trajectories cannot honor it.
 */
function validateAgentSourceSelection(params: GrepParams, sources: ValidSource[]): void {
  const hasTrajectories = sources.includes('agent_trajectories');
  if (hasTrajectories) {
    for (const key of ['order', 'page_after'] as const) {
      if (params[key] !== undefined && sources.length !== 1) {
        throw new InvalidGrepParamError(
          key,
          `${key} pages an agent_trajectories search only when agent_trajectories is the only source; search it alone or remove ${key}.`
        );
      }
    }
    return;
  }
  if (sources.includes('agent_network')) {
    validateAgentNetworkSelectors(params);
    return;
  }
  for (const key of ['role', 'record_kind', 'surface', 'trace_path', 'page_after'] as const) {
    if (params[key] !== undefined) throw new InvalidGrepParamError(key, AGENT_SELECTOR_HINT[key]);
  }
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
 * Sources in precedence order: explicit `sources`/`source`; typed trajectory
 * narrowing; sources the filters name (a nested block or a printed path);
 * otherwise the local defaults, which take no filters.
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
        : hasTrajectoryNarrowing(params, split)
          ? ['agent_trajectories']
          : named.length > 0
            ? named
            : DEFAULT_GREP_SOURCES;
  if (sources === undefined && source === undefined && named.length === 0 && hasFilters(split)) {
    if (!hasTrajectoryNarrowing(params, split)) {
      throw new InvalidGrepParamError(
        'filters',
        'Name the source(s) these filters apply to in sources, such as sources: ["messages"], or nest them as {"messages": {...}}.'
      );
    }
  }
  validateAgentSourceSelection(params, resolvedSources);
  return {
    resolvedSources,
    patternOptional:
      resolvedSources.includes('agent_trajectories') ||
      resolvedSources.includes('agent_network') ||
      resolvedSources.every(isGoogleGrepSource),
  };
}

function parseSourceFilters(
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
