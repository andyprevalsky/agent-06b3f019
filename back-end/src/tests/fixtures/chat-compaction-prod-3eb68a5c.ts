/**
 * Prod-shaped chat history for agent 3eb68a5c-4787-445a-85ce-814c7397baeb (2026-08-24).
 *
 * After a long research run completed, follow-up chat messages failed because chat mode
 * loaded ~586 messages (~339k estimated tokens) into Router/Generator with no compaction.
 * OpenRouter rejected the request at 262,144 tokens; failover exhausted; the user saw
 * "Sorry — I couldn't generate a response just now. Please try again."
 */

import type { ChatMessage } from '../../providers/chat/initialContext';

export const PROD_CHAT_COMPACTION_AGENT_ID = '3eb68a5c-4787-445a-85ce-814c7397baeb';

export const PROD_CHAT_COMPACTION_FOLLOW_UP =
  'i said 5 more options to look through, use ur existing research';

export const PROD_CHAT_COMPACTION_CONTINUE = 'continue';

const RESEARCH_TOOLS = ['web_search', 'web_fetch', 'spawn_agent'] as const;

function researchToolPayload(toolName: (typeof RESEARCH_TOOLS)[number], index: number): unknown {
  if (toolName === 'web_search') {
    return {
      results: Array.from({ length: 8 }, (_, resultIndex) => ({
        title: `Option ${index}-${resultIndex}: boutique hotel near conference venue`,
        url: `https://example.com/research/${index}/${resultIndex}`,
        snippet: 'Rates, amenities, and walkability notes from the prior research pass. '.repeat(
          12
        ),
      })),
    };
  }
  if (toolName === 'web_fetch') {
    return {
      url: `https://example.com/hotels/${index}`,
      body: 'Fetched listing details with nightly rate bands and cancellation policy. '.repeat(80),
      extracted: {
        property: `Hotel candidate ${index}`,
        price: `$${180 + (index % 40)}`,
        notes: 'Pool, breakfast, and transit time to the venue. '.repeat(20),
      },
    };
  }
  return {
    agent_id: `sub-${index}`,
    summary:
      'Explore agent reviewed local contacts and prior web results for additional hotel options. '.repeat(
        30
      ),
    status: 'FINISHED',
  };
}

/**
 * Build a post-completion chat transcript that mirrors the prod failure shape:
 * metadata-heavy TOOL rows, empty-text ASSISTANT tool-call rows, and the exact follow-ups
 * that failed once the workflow had already returned to chat mode.
 */
export function buildProdChatCompactionScenario(cycleCount = 290): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'USER',
      text: 'Research boutique hotel options near the conference venue and compare 5 strong candidates.',
      metadata: {},
    },
    {
      role: 'ASSISTANT',
      text: 'I will research hotel options and compare the strongest candidates.',
      metadata: {},
    },
  ];

  for (let index = 0; index < cycleCount; index += 1) {
    const toolName = RESEARCH_TOOLS[index % RESEARCH_TOOLS.length];
    const toolCallId = `toolu_prod_${index}`;
    messages.push({
      role: 'ASSISTANT',
      text: '',
      metadata: {
        tool_calls: [
          {
            tool: toolName,
            tool_call_id: toolCallId,
            goal:
              toolName === 'spawn_agent'
                ? `Find 5 more hotel options using prior research context. `.repeat(20)
                : `query: boutique hotels near venue option set ${index}`,
          },
        ],
      },
    });
    messages.push({
      role: 'TOOL',
      text: toolName === 'web_fetch' ? '' : `${toolName} finished`,
      metadata: {
        toolCallId,
        toolName,
        toolStatus: 'FINISHED',
        title: `${toolName} result ${index}`,
        structured_response: researchToolPayload(toolName, index),
      },
    });
  }

  messages.push({
    role: 'ASSISTANT',
    text: 'I finished the research run and compared the strongest hotel options with rates, amenities, and tradeoffs.',
    metadata: { completionSummary: true },
  });
  messages.push({
    role: 'TOOL',
    text: 'Agent completed successfully.',
    metadata: {
      toolName: 'completion_summary',
      toolStatus: 'FINISHED',
      title: 'Research complete',
    },
  });
  messages.push({
    role: 'USER',
    text: PROD_CHAT_COMPACTION_FOLLOW_UP,
    metadata: {},
  });
  messages.push({
    role: 'ASSISTANT',
    text: 'Sorry — I could not generate a response just now. Please try again.',
    metadata: { chatFailure: true },
  });
  messages.push({
    role: 'USER',
    text: PROD_CHAT_COMPACTION_CONTINUE,
    metadata: {},
  });

  return messages;
}
