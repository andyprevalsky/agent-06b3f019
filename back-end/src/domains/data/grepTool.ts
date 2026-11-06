/**
 * The one grep tool executor: every surface that offers grep runs its calls here.
 *
 *   explore agent ── POST /api/data/grep ──┐
 *   SMS supervisor ── userDataSearch ──────┼─> executeGrepTool ─┬─ sources ["summary"] → inventory text
 *   web chat ─────── userDataSearch ───────┘                    └─ grep() ── invalid regex → literal retry
 *
 * The tool definition these calls follow lives in providers/grepTool. The
 * agents layer keeps only what needs its workflow (connector gating).
 */

import { InvalidPatternError } from './errors';
import { formatLocalDataSummary } from './format.summary';
import { getSummary, grep } from './service';
import type { GrepParams, GrepResult } from './types';

/** Agent-side hints in the tool definition that the search itself does not take. */
const AGENT_ONLY_KEYS = ['require_source_access'] as const;

export interface GrepToolResult extends Omit<
  GrepResult,
  'sources' | 'display_order' | 'context_unit'
> {
  sources: string[];
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

export async function executeGrepTool(
  userId: string,
  rawArgs: Record<string, unknown>
): Promise<GrepToolResult> {
  const params: Record<string, unknown> = { ...rawArgs };
  for (const key of AGENT_ONLY_KEYS) delete params[key];
  const pattern = typeof params.pattern === 'string' ? params.pattern : '';
  if (isSummaryRequest(params)) return summaryResult(userId, pattern);
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
