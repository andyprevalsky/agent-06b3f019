/**
 * SMS supervisor `grep` tool: the shared grep tool, run on the shared executor.
 *
 *   LLM grep call (providers/grepTool definition, strict form)
 *        └─> executeUserDataGrepTool(userId, args) ─> domains/data/grepTool ─> JSON result
 *
 * The explore agent and web chat call the same executor, so all three accept
 * the same arguments and return the same result. The supervisor is not an
 * agent: with no agent tree, the default sources leave agent_network out and
 * an explicit agent_network search reports that it needs an agent.
 */

import { createLogger } from '../logger';
import { executeUserDataGrepTool, type UserDataGrepToolResult } from '../userDataSearch';
import type { ToolResult } from './supervisorTools';

const log = createLogger('SmsSupervisorGrep');

export type GrepArgs = Record<string, unknown>;

export async function executeGrepTool(args: GrepArgs, userId: string): Promise<ToolResult> {
  const startTime = Date.now();
  log.info('Executing grep', {
    pattern: typeof args.pattern === 'string' ? args.pattern : '',
    sources: args.sources ?? args.source ?? 'default',
    userId,
  });

  let result: UserDataGrepToolResult;
  try {
    result = await executeUserDataGrepTool(userId, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('Grep failed', { error: message, durationMs: Date.now() - startTime });
    return { tool: 'grep', success: false, result: '', error: message };
  }

  log.info('Grep complete', {
    pattern: result.pattern,
    sources: result.sources,
    totalMatches: result.total_matches,
    returned: result.matches.length,
    truncated: result.truncated,
    durationMs: Date.now() - startTime,
  });

  return { tool: 'grep', success: true, result: JSON.stringify(result) };
}
