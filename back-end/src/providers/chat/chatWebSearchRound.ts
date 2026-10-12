/**
 * One round of chat web searches. The Router's queries run in parallel and
 * each one persists as its own web_search tool result, in query order, so the
 * next route (and the Generator) read them deterministically.
 *
 *   web_search decision ──> ASSISTANT row with the Router's reasoning
 *                       ──> IN_PROGRESS chip per query (the first may already
 *                           be on screen from early stream detection)
 *                       ──> Parallel searches, at most 4 in flight
 *                       ──> FINISHED result per query, in query order
 */

import { v4 as uuidv4 } from 'uuid';
import { createMessage } from '../messages';
import { agentFastMode } from '../fastCacheStore';
import { mapWithConcurrency } from '../concurrency';
import { createLogger } from '../logger';
import { executeWebSearch } from './chatTools';
import type { RouterDecision } from './routerDecision';
import { formatWebSearchStreamTitle } from './routerJsonStream';
import { broadcastToolEvent, generateStreamId } from './supabaseBroadcast';

const log = createLogger('ChatHandler');
const MAX_CONCURRENT_SEARCHES = 4;

export type WebSearchDecision = Extract<RouterDecision, { action: 'web_search' }>;

export async function runChatWebSearchRound(params: {
  agentId: string;
  decision: WebSearchDecision;
  /** Tool call already announced for the first query while the Router streamed. */
  earlyToolCallId?: string;
}): Promise<void> {
  const { agentId, decision } = params;
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

  // The Router's reasoning precedes its tool rows, matching worker behavior.
  await createMessage({ agentId, role: 'ASSISTANT', text: decision.reasoning });

  for (const search of searches) {
    const title = formatWebSearchStreamTitle(search.query);
    if (!search.announced) {
      await broadcastToolEvent(
        agentId,
        streamId,
        search.toolCallId,
        'web_search',
        'IN_PROGRESS',
        title
      );
    }
    // createMessage() auto-broadcasts INSERT events to the frontend.
    await createMessage({
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

  // Backend chat mode does not go through the Python web_search_activity, so
  // it passes Fast Mode context explicitly.
  const fastMode = await agentFastMode(agentId);
  const results = await mapWithConcurrency(searches, MAX_CONCURRENT_SEARCHES, (search) =>
    executeWebSearch(search.query, fastMode.goal, fastMode.enabled, fastMode.writeEnabled)
  );

  for (const [index, search] of searches.entries()) {
    const result = results[index];
    await createMessage({
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
