/**
 * The one grep tool executor: every surface that offers grep runs its calls here.
 *
 *   explore agent ── POST /api/data/grep ──┐
 *   SMS supervisor ── userDataSearch ──────┼─> executeGrepTool ─┬─ sources ["summary"] → inventory text
 *   web chat ─────── userDataSearch ───────┘   (reportUnconnected│   for SMS/chat: named sources whose
 *                                                                │   connector is missing are skipped
 *                                                                │   with a "not connected" notice)
 *                                                                └─ grep() ── invalid regex → literal retry
 *
 * The tool definition these calls follow lives in providers/grepTool. The
 * explore agent gates unconnected sources in its own workflow (it can ask the
 * user to connect), so its route does not report them here.
 */

import { InvalidPatternError } from './errors';
import { formatLocalDataSummary } from './format.summary';
import { getSummary, grep } from './service';
import { getSourceStatus, type SourceStatus } from './sourceStatus';
import {
  DATA_SOURCE_CONFIGS,
  isMessageFamilySource,
  type GrepParams,
  type GrepResult,
  type ValidSource,
} from './types';
import { isSourceName } from './validate.normalize';

/** The explore agent's provider aliases (agents/domains/grep/service.py). */
const DOCUMENT_PROVIDER_ALIASES: Record<string, string> = {
  chat_gpt: 'chatgpt',
  chatgpy: 'chatgpt',
  notes: 'apple_notes',
  apple: 'apple_notes',
};

/** Shorthands that apply like flat filter keys (validate.normalize.ts BROADCAST_PARAMS). */
const SHORTHAND_KEYS = ['person', 'since', 'until'] as const;

/** Agent-side hints in the tool definition that the search itself does not take. */
const AGENT_ONLY_KEYS = ['require_source_access'] as const;

export interface GrepToolResult extends Omit<
  GrepResult,
  'sources' | 'display_order' | 'context_unit'
> {
  sources: string[];
  unavailable_sources?: SourceStatus[];
  display_order?: GrepResult['display_order'];
  context_unit?: GrepResult['context_unit'];
  literal_fallback?: true;
  original_pattern?: string;
  effective_pattern?: string;
}

function isSummaryRequest(params: Record<string, unknown>): boolean {
  const { sources, source } = params;
  if (Array.isArray(sources) && sources.length > 0) {
    return sources.every((entry) => String(entry).toLowerCase() === 'summary');
  }
  return String(source ?? '').toLowerCase() === 'summary';
}

async function summaryResult(userId: string, pattern: string): Promise<GrepToolResult> {
  const text = formatLocalDataSummary(await getSummary(userId));
  const empty = text === 'No local data available.';
  const matches = empty
    ? []
    : [{ source: 'summary', path: 'local_data_summary', content: text } as never];
  return {
    matches,
    total_matches: matches.length,
    truncated: false,
    pattern,
    sources: ['summary'],
    applied_limit: matches.length,
    applied_offset: 0,
    returned: matches.length,
    has_more: false,
    next_offset: null,
    message: text,
  };
}

function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInvalidRegex(error: unknown): boolean {
  return (
    error instanceof InvalidPatternError &&
    error.message.toLowerCase().includes('invalid regular expression')
  );
}

/** A filter value that says something: strict surfaces spell every absent key as null. */
function present(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Sources the call names: `sources`/`source`, else the nested filter blocks it
 * fills (a block of only nulls names nothing) and the root of a printed path,
 * as the backend resolves them (validate.normalize.ts) and the explore agent's
 * gate reads them (agents/domains/grep/service.py `_sources_named_by_filters`).
 */
function namedSources(params: Record<string, unknown>): string[] {
  if (Array.isArray(params.sources) && params.sources.length > 0) return params.sources.map(String);
  if (typeof params.source === 'string') return [params.source];
  const filters = params.filters;
  if (typeof filters !== 'object' || filters === null) return [];
  const named = Object.entries(filters as Record<string, unknown>)
    .filter(
      ([key, block]) =>
        isSourceName(key) &&
        typeof block === 'object' &&
        block !== null &&
        Object.values(block).some(present)
    )
    .map(([key]) => key);
  const path = (filters as Record<string, unknown>).path;
  const root = typeof path === 'string' ? path.split('/', 1)[0] : '';
  if (isSourceName(root) && !named.includes(root)) named.push(root);
  return named;
}

/**
 * Named sources whose connector is not connected. Local sources never are;
 * `documents` is a corpus, so only an explicitly required provider counts
 * (the explore agent's gating rule, agents/domains/grep/service.py).
 */
async function unconnectedSources(
  userId: string,
  params: Record<string, unknown>,
  requireSourceAccess: boolean
): Promise<SourceStatus[]> {
  const probes: string[] = namedSources(params).filter(
    (source) => source !== 'documents' && isSourceName(source)
  );
  const provider = documentProvider(params);
  if (namedSources(params).includes('documents') && provider !== undefined && requireSourceAccess) {
    probes.push(provider);
  }
  if (probes.length === 0) return [];
  const statuses = await getSourceStatus(userId, [...new Set(probes)]);
  return statuses.filter((status) => !status.connected);
}

function documentProvider(params: Record<string, unknown>): string | undefined {
  const filters = (params.filters ?? {}) as Record<string, unknown>;
  const nested = filters.documents as Record<string, unknown> | null | undefined;
  const value = nested?.document_source ?? filters.document_source;
  if (typeof value !== 'string' || value === '') return undefined;
  const key = value.toLowerCase().replace(/[\s-]+/g, '_');
  return DOCUMENT_PROVIDER_ALIASES[key] ?? key;
}

function accepts(sources: ValidSource[], key: string): boolean {
  return sources.some((source) =>
    (DATA_SOURCE_CONFIGS[source].filters as readonly string[]).includes(key)
  );
}

/** The call restricted to `kept`: skipped sources' blocks and keys only they accepted are dropped. */
function narrowTo(params: Record<string, unknown>, kept: ValidSource[]): Record<string, unknown> {
  const narrowed: Record<string, unknown> = { ...params, sources: kept };
  delete narrowed.source;
  for (const key of SHORTHAND_KEYS) if (!accepts(kept, key)) delete narrowed[key];
  const filters = params.filters;
  if (typeof filters === 'object' && filters !== null) {
    const keptFilters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filters)) {
      const block = isSourceName(key);
      const keep = block
        ? kept.includes(key) || (key === 'messages' && kept.some(isMessageFamilySource))
        : accepts(kept, key);
      if (keep) keptFilters[key] = value;
    }
    narrowed.filters = keptFilters;
  }
  return narrowed;
}

function unconnectedNotice(unavailable: SourceStatus[]): string {
  const names = unavailable.map((status) => status.source).join(', ');
  const links = [...new Set(unavailable.map((status) => status.connectUrl).filter(Boolean))].join(
    ', '
  );
  return (
    `Source(s) not connected: ${names}. These were skipped — do NOT retry them. ` +
    `The user can connect them at ${links}; continue with any other available sources ` +
    'and report what you could and could not search.'
  );
}

function emptyResult(
  pattern: string,
  message: string,
  unavailable: SourceStatus[]
): GrepToolResult {
  return {
    matches: [],
    total_matches: 0,
    truncated: false,
    pattern,
    sources: [],
    applied_limit: 0,
    applied_offset: 0,
    returned: 0,
    has_more: false,
    next_offset: null,
    message,
    unavailable_sources: unavailable,
  };
}

export interface GrepToolOptions {
  /** Callers with no connect gate (SMS, chat) report and skip unconnected named sources. */
  reportUnconnected?: boolean;
}

export async function executeGrepTool(
  userId: string,
  rawArgs: Record<string, unknown>,
  options: GrepToolOptions = {}
): Promise<GrepToolResult> {
  let params: Record<string, unknown> = { ...rawArgs };
  const requireSourceAccess = params.require_source_access === true;
  for (const key of AGENT_ONLY_KEYS) delete params[key];
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  if (isSummaryRequest(params)) return summaryResult(userId, pattern);
  const unavailable =
    options.reportUnconnected === true
      ? await unconnectedSources(userId, params, requireSourceAccess)
      : [];
  if (unavailable.length > 0) {
    const notice = unconnectedNotice(unavailable);
    const skipped = new Set(unavailable.map((status) => status.source));
    const kept = namedSources(params).filter(
      (source): source is ValidSource =>
        isSourceName(source) &&
        !skipped.has(source) &&
        !(source === 'documents' && skipped.has(documentProvider(params) ?? ''))
    );
    if (kept.length === 0) return emptyResult(pattern, notice, unavailable);
    params = narrowTo(params, kept);
    const result = await runGrep(userId, params, pattern);
    const message = result.message === undefined ? notice : `${notice} ${result.message}`;
    return { ...result, message, unavailable_sources: unavailable };
  }
  return runGrep(userId, params, pattern);
}

async function runGrep(
  userId: string,
  params: Record<string, unknown>,
  pattern: string
): Promise<GrepToolResult> {
  try {
    return await grep(userId, params as GrepParams);
  } catch (error) {
    if (!isInvalidRegex(error) || pattern === '') throw error;
    // A plain-text search the model wrote as a broken regex still finds the literal text.
    const effective = escapeRegex(pattern);
    const result = await grep(userId, { ...params, pattern: effective } as GrepParams);
    return {
      ...result,
      literal_fallback: true,
      original_pattern: pattern,
      effective_pattern: effective,
    };
  }
}

/** The grep tool for callers with no connect gate (SMS supervisor, web chat). */
export function executeGatelessGrepTool(
  userId: string,
  args: Record<string, unknown>
): Promise<GrepToolResult> {
  return executeGrepTool(userId, args, { reportUnconnected: true });
}
