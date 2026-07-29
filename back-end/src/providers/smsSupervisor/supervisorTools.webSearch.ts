/**
 * SMS supervisor web_search tool.
 *
 * Split out of supervisorTools.ts to keep that file under its max-lines budget,
 * alongside supervisorTools.grep.ts and supervisorTools.helpers.ts.
 */

import { readFileSync } from 'node:fs';

import { executeWebSearch } from '../chat/chatTools';
import { createLogger } from '../logger';

import type { ToolResult } from './supervisorTools';

const log = createLogger('SmsSupervisorWebSearch');

export interface WebSearchArgs {
  query: string;
}

/**
 * Benchmark-only web_search stub.
 *
 * The SMS trajectory benchmarks turn on what the world tells the supervisor:
 * "the restaurant is closed" must end in a reply and nothing else, while "it is
 * open" must end in a spawned agent. Live search cannot express that difference
 * on demand -- the restaurant's real hours decide the test's outcome, so the
 * same code would pass on Tuesday and fail on Sunday.
 *
 * So web_search is the single mocked boundary in those runs. Everything else --
 * context build, LLM, tool loop, spawn, delivery -- stays real.
 *
 * Read from a FILE, not an env var: the backend is already running by the time a
 * task starts, so it can never observe an env var the benchmark process sets for
 * itself. The path comes from BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE, which only
 * the local benchmark stack sets; absent file or absent env means live search.
 */
function benchmarkWebSearchFixture(query: string): string | null {
  const path = process.env.BENCHMARK_SMS_WEB_SEARCH_FIXTURE_FILE;
  if (path === undefined || path === '') return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch {
    // No file for this task -- it declared no fixture, so use live search.
    return null;
  }
  if (raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const entries = parsed as Record<string, string>;
      const hit = Object.keys(entries).find((key) =>
        query.toLowerCase().includes(key.toLowerCase())
      );
      // `default` lets a fixture answer every query the model happens to try,
      // so a benchmark does not hinge on guessing its exact search phrasing.
      return hit !== undefined ? entries[hit] : (entries.default ?? null);
    }
  } catch {
    log.warn('Ignoring unparseable web-search fixture', { phase: 'search' });
  }
  return null;
}

export async function executeWebSearchTool(args: WebSearchArgs): Promise<ToolResult> {
  const { query } = args;

  const fixture = benchmarkWebSearchFixture(query);
  if (fixture !== null) {
    log.info('Serving benchmark web-search fixture', { phase: 'search', query });
    return { tool: 'web_search', success: true, result: fixture };
  }

  log.info('Executing web search', { phase: 'search', query });
  const startTime = Date.now();

  const searchResult = await executeWebSearch(query);

  log.info('Search complete', {
    phase: 'search',
    query,
    answerLength: searchResult.answer.length,
    sourceCount: searchResult.sources.length,
    durationMs: Date.now() - startTime,
  });

  return {
    tool: 'web_search',
    success: true,
    result: searchResult.answer,
  };
}
