/**
 * Prod-shaped chat history for agent 3b5c2813-c8bd-4ddb-a8bf-f7561c1f7125 (2026-09-28).
 *
 * After a long SF-sublet research run completed (~2100 messages, mostly explore /
 * browser TOOL rows tagged with metadata.subAgentId), a follow-up chat message
 * failed with chat_handler_failure. Router/Generator received ~1866 messages
 * (~825k tokens); Cerebras/OpenRouter rejected at 131k. Compaction never ran
 * because estimateContextTokens skips subAgentId rows while chat mode still
 * forwarded their text bodies to the model.
 */

import type { ChatMessage } from '../../providers/chat/initialContext';

export const PROD_CHAT_SUBAGENT_LEAK_AGENT_ID = '3b5c2813-c8bd-4ddb-a8bf-f7561c1f7125';

export const PROD_CHAT_SUBAGENT_LEAK_FOLLOW_UP =
  "that link doesn't even work\nand I said I demand 10";

/**
 * Build a post-completion transcript that mirrors the prod failure shape:
 * root goal + completion summary, flooded with explore web_fetch bodies that
 * carry subAgentId (estimator skips them; Router historically included them).
 */
export function buildProdChatSubagentLeakScenario(exploreFetchCount = 800): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'USER',
      text: 'find me sublets in sf from oct 18th - dec 10th, < 3k a month',
      metadata: {},
    },
    {
      role: 'ASSISTANT',
      text: 'I will research Craigslist, FB Marketplace, and Airbnb options.',
      metadata: {},
    },
    {
      role: 'TOOL',
      text: '',
      metadata: {
        toolName: 'spawn_agent',
        toolStatus: 'FINISHED',
        toolCallId: 'spawn-root-1',
        title: 'Explore SF sublets',
      },
    },
  ];

  for (let index = 0; index < exploreFetchCount; index += 1) {
    messages.push({
      role: 'TOOL',
      text: (
        `Fetched Airbnb listing ${index} for Oct 18–Dec 10 one guest under $3000/mo. ` +
        'Amenities, neighborhood notes, and cancellation policy. '
      ).repeat(80),
      metadata: {
        toolName: 'web_fetch',
        toolStatus: 'FINISHED',
        toolCallId: `explore-fetch-${index}`,
        subAgentId: `29fda27f-f89e-5252-827f-39a36f1970${String(index % 10).padStart(2, '0')}`,
        title: `Fetched listing ${index}`,
        workflowGeneration: '1',
      },
    });
  }

  messages.push(
    {
      role: 'TOOL',
      text: '',
      metadata: {
        toolName: 'attempt_completion',
        toolStatus: 'FINISHED',
        toolCallId: 'complete-1',
        title: 'Progress: 100%',
      },
    },
    {
      role: 'TOOL',
      text: 'Top options summarized for the user.',
      metadata: {
        toolName: 'completion_summary',
        toolStatus: 'FINISHED',
        toolCallId: 'summary-1',
        isFinalSummary: true,
        completionSummary: true,
        title: 'Task Complete',
      },
    },
    {
      role: 'USER',
      text: PROD_CHAT_SUBAGENT_LEAK_FOLLOW_UP,
      metadata: {},
    }
  );

  return messages;
}
