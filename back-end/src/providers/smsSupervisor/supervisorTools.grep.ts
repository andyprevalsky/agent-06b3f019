/**
 * SMS supervisor `grep` tool — symmetrical port of the explore agent's grep.
 *
 * The explore agent (agents/domains/grep/repo.py) POSTs the same args to
 * /api/data/grep and hands the raw JSON GrepResult to its LLM. Here the call
 * goes in-process through the userDataSearch bridge (registered from
 * server.ts) and the LLM gets the same JSON. One asymmetry: the supervisor is
 * not an agent, so the agent_network source (which requires an agent_id) is
 * unavailable; an omitted source searches messages + network instead of the
 * explore default of messages + network + agent_network.
 */

import { createLogger } from '../logger';
import { executeUserDataGrep, UserDataGrepParams, UserDataGrepResult } from '../userDataSearch';
import type { ToolResult } from './supervisorTools';

const log = createLogger('SmsSupervisorGrep');

export interface GrepArgs {
  pattern: string;
  source?: string | null;
  context?: number | null;
  '-B'?: number | null;
  '-A'?: number | null;
  '-C'?: number | null;
  '-n'?: boolean | null;
  '-i'?: boolean | null;
  head_limit?: number | null;
  offset?: number | null;
  multiline?: boolean | null;
  filters?: Record<string, unknown> | null;
  person?: string | null;
  since?: string | null;
}

const OMITTED_SOURCE_FAN_OUT = ['messages', 'network'] as const;

/** Drop null/undefined keys so the domain's strict validation sees only real args. */
function stripNullish(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function toGrepParams(args: GrepArgs): UserDataGrepParams {
  const params = stripNullish(args as unknown as Record<string, unknown>);
  // The strict LLM schema makes every filter key required-but-nullable, so a
  // filters object arrives fully populated with nulls; the domain rejects
  // null-valued keys as unsupported for the source. Strip them, and drop the
  // object entirely when nothing real remains.
  if (params.filters !== undefined) {
    const filters = stripNullish(params.filters as Record<string, unknown>);
    if (Object.keys(filters).length === 0) {
      delete params.filters;
    } else {
      params.filters = filters;
    }
  }
  return params as unknown as UserDataGrepParams;
}

function mergeFanOutResults(results: UserDataGrepResult[], limit: number): UserDataGrepResult {
  const matches = results
    .flatMap((r) => r.matches)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit);
  const totalMatches = results.reduce((sum, r) => sum + r.total_matches, 0);
  const messages = results.map((r) => r.message).filter((m): m is string => m !== undefined);
  return {
    matches,
    total_matches: totalMatches,
    truncated: totalMatches > matches.length || results.some((r) => r.truncated),
    pattern: results[0].pattern,
    sources: results.flatMap((r) => r.sources),
    applied_limit: limit,
    applied_offset: results[0].applied_offset,
    returned: matches.length,
    has_more: totalMatches > matches.length || results.some((r) => r.has_more),
    next_offset:
      totalMatches > matches.length || results.some((r) => r.has_more)
        ? results[0].applied_offset + matches.length
        : null,
    display_order: 'newest_first',
    context_unit: 'mixed',
    ...(messages.length === results.length && messages.length > 0
      ? { message: messages.join(' ') }
      : {}),
  };
}

export async function executeGrepTool(args: GrepArgs, userId: string): Promise<ToolResult> {
  const params = toGrepParams(args);
  const startTime = Date.now();
  log.info('Executing grep', { pattern: params.pattern, source: params.source ?? 'all', userId });

  if (params.source === 'agent_network') {
    return {
      tool: 'grep',
      success: false,
      result: '',
      error:
        "source 'agent_network' is not available in this surface. Supported sources: messages, network, transactions, documents.",
    };
  }

  let result: UserDataGrepResult;
  if (params.source === undefined) {
    if (params.filters !== undefined) {
      // Mirrors the domain's validateGrepInput: nested filters need an explicit source.
      return {
        tool: 'grep',
        success: false,
        result: '',
        error:
          'filters require an explicit source. Pick one of: messages, network, transactions, documents.',
      };
    }
    const perSource = await Promise.all(
      OMITTED_SOURCE_FAN_OUT.map((source) => executeUserDataGrep(userId, { ...params, source }))
    );
    result = mergeFanOutResults(perSource, perSource[0].applied_limit);
  } else {
    result = await executeUserDataGrep(userId, params);
  }

  log.info('Grep complete', {
    pattern: params.pattern,
    sources: result.sources,
    totalMatches: result.total_matches,
    returned: result.matches.length,
    truncated: result.truncated,
    durationMs: Date.now() - startTime,
  });

  return { tool: 'grep', success: true, result: JSON.stringify(result) };
}
