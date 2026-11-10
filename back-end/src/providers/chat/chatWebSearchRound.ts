/**
 * One round of chat web searches. The Router's queries run in parallel and
 * each one persists as its own web_search tool result, in query order, so the
 * next route (and the Generator) read them deterministically.
 *
 *   web_search decision ──> Fast Mode context (a failure ends the turn before
 *                           any chip is persisted)
 *                       ──> ASSISTANT row with the Router's reasoning
 *                       ──> IN_PROGRESS chip per query (the first may already
 *                           be on screen from early stream detection)
 *                       ──> Parallel searches, at most 4 in flight; a failed
 *                           one reports an error result instead of failing
 *                           the round
 *                       ──> FINISHED result per query, in query order
 */

import { v4 as uuidv4 } from 'uuid';
import { createMessage } from '../messages';
import { agentFastMode } from '../demoCacheStore';
import { mapWithConcurrency } from '../concurrency';
import { createLogger } from '../logger';
import { executeWebSearch, webSearchErrorResult } from './chatTools';
import { executeUserDataGrep, executeUserDataSummary } from '../userDataSearch';
import { chatGrepParams } from './chatGrepSchema';
import type { RouterDecision } from './routerDecision';
import { formatWebSearchStreamTitle } from './routerJsonStream';
import { broadcastToolEvent, generateStreamId } from './supabaseBroadcast';

const log = createLogger('ChatHandler');
const MAX_CONCURRENT_SEARCHES = 4;

export type WebSearchDecision = Extract<RouterDecision, { action: 'web_search' }>;
export type ChatSearchDecision = Extract<RouterDecision, { action: 'web_search' | 'grep' }>;

export type ChatWebSearchRoundDeps = {
  createMessage: typeof createMessage;
  broadcastToolEvent: typeof broadcastToolEvent;
  agentFastMode: typeof agentFastMode;
  executeWebSearch: typeof executeWebSearch;
};

const defaultDeps: ChatWebSearchRoundDeps = {
  createMessage,
  broadcastToolEvent,
  agentFastMode,
  executeWebSearch,
};

export async function runChatWebSearchRound(
  params: {
    agentId: string;
    decision: ChatSearchDecision;
    userId?: string;
    /** Identity of the Router reasoning stream, distinct from the tool stream. */
    routerStreamId: string;
    /** Tool call already announced for the first query while the Router streamed. */
    earlyToolCallId?: string;
  },
  deps: ChatWebSearchRoundDeps = defaultDeps
): Promise<void> {
  const { agentId, decision } = params;
  if (decision.action === 'grep') {
    if (!params.userId) throw new Error('Chat grep requires the authenticated user identity');
    const toolCallId = uuidv4();
    const title = `Searching user data: ${decision.grep.pattern ?? decision.grep.sources?.join(', ') ?? 'records'}`;
    await deps.createMessage({
      agentId,
      role: 'ASSISTANT',
      text: decision.reasoning,
      metadata: { streamId: params.routerStreamId },
    });
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text: '',
      skipDuplicateToolCheck: true,
      metadata: { title, toolName: 'grep', toolCallId, toolStatus: 'IN_PROGRESS' },
    });
    let text: string;
    let error: string | undefined;
    try {
      const args = chatGrepParams(decision.grep);
      const sources = args.sources as string[] | undefined;
      const summaryOnly = sources?.length
        ? sources.length === 1 && sources[0] === 'summary'
        : args.source === 'summary';
      const result = summaryOnly
        ? await executeUserDataSummary(params.userId)
        : await executeUserDataGrep(params.userId, { ...args, agent_id: agentId });
      text = JSON.stringify(result);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      text = JSON.stringify({ error });
      log.error('[ChatHandler] Grep failed', { agentId, error });
    }
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text,
      skipDuplicateToolCheck: true,
      metadata: {
        title,
        toolName: 'grep',
        toolCallId,
        toolStatus: 'FINISHED',
        ...(error ? { error } : {}),
      },
    });
    return;
  }
  const streamId = generateStreamId();
  const searches = [...new Set(decision.queries.map((query) => query.trim()))].map(
    (query, index) => {
      const announced = index === 0 && params.earlyToolCallId !== undefined;
      return {
        query,
        displayQuery: query.length > 80 ? `${query.slice(0, 77)}...` : query,
        toolCallId: announced ? (params.earlyToolCallId as string) : uuidv4(),
        announced,
      };
    }
  );

  log.info('[ChatHandler] Executing web searches', {
    agentId,
    queries: searches.map((search) => search.query),
    firstDetectedEarly: params.earlyToolCallId !== undefined,
  });

  // Backend chat mode does not go through the Python web_search_activity, so
  // it passes Fast Mode context explicitly.
  const fastMode = await deps.agentFastMode(agentId);

  // The Router's reasoning precedes its tool rows, matching worker behavior.
  await deps.createMessage({
    agentId,
    role: 'ASSISTANT',
    text: decision.reasoning,
    metadata: { streamId: params.routerStreamId },
  });

  for (const search of searches) {
    const title = formatWebSearchStreamTitle(search.query);
    if (!search.announced) {
      await deps.broadcastToolEvent(
        agentId,
        streamId,
        search.toolCallId,
        'web_search',
        'IN_PROGRESS',
        title
      );
    }
    // createMessage() auto-broadcasts INSERT events to the frontend.
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text: '',
      skipDuplicateToolCheck: true,
      metadata: {
        title,
        toolName: 'web_search',
        toolCallId: search.toolCallId,
        toolStatus: 'IN_PROGRESS',
      },
    });
  }

  const results = await mapWithConcurrency(searches, MAX_CONCURRENT_SEARCHES, (search) =>
    deps
      .executeWebSearch(search.query, fastMode.goal, fastMode.enabled, fastMode.writeEnabled)
      .catch((error: unknown) => {
        log.error('[ChatHandler] Web search failed', {
          agentId,
          query: search.query,
          error: error instanceof Error ? error.message : String(error),
        });
        return webSearchErrorResult(error);
      })
  );

  for (const [index, search] of searches.entries()) {
    const result = results[index];
    await deps.createMessage({
      agentId,
      role: 'TOOL',
      text: `Web search: "${search.query}"\n\n${result.answer}\n\nSources: ${result.sources.join(', ')}`,
      skipDuplicateToolCheck: true,
      metadata: {
        title: `Web search completed for ${search.displayQuery}`,
        toolName: 'web_search',
        toolCallId: search.toolCallId,
        toolStatus: 'FINISHED',
        query: search.query,
        sources: result.sources,
      },
    });
  }
}
