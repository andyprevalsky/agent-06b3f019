/**
 * Blackbox tests: one row per turn for a chat turn's web searches.
 *
 * Covers:
 *  - Several searches across rounds (router Thought rows in between) render as
 *    one "Searching N web searches" row, then "Searched N web searches"
 *  - The row keeps the web_search data attributes; FINISHED only once all are
 *  - Expanding the finished row shows every query's result
 *  - Turn boundaries: the next turn's searches start their own row
 *  - A single search keeps its own chip
 *  - A live search chip folds into the turn's row instead of the list tail
 *  - A hidden search's animation slot is released through the group row
 */
import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import { MessageListItems } from '@/features/terminal-component-group/components/MessageListItems';
import { groupWebSearchTurns } from '@/features/terminal-component-group/components/webSearchTurnGroups';
import type { Message } from '@/lib/api';

vi.mock('@/lib/macAppHandoff', () => ({ attemptMacAppHandoff: vi.fn() }));

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

const BASE = Date.parse('2026-10-12T20:00:00.000Z');

function at(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

function user(id: string, seconds: number, text = id): Message {
  return { message_id: id, role: 'USER', text, timestamp: at(seconds) };
}

function thought(id: string, seconds: number): Message {
  return { message_id: id, role: 'ASSISTANT', text: `reasoning ${id}`, timestamp: at(seconds) };
}

function search(id: string, seconds: number, query: string, done: boolean): Message {
  return {
    message_id: id,
    role: 'TOOL',
    text: done ? `Web search: "${query}"\n\nresult for ${query}\n\nSources: https://e.com` : '',
    timestamp: at(seconds),
    metadata: {
      toolCallId: `call-${query}`,
      toolName: 'web_search',
      toolStatus: done ? 'FINISHED' : 'IN_PROGRESS',
      title: done ? `Web search completed for ${query}` : `🔍 Searching the web for ${query}`,
      query,
    },
  };
}

function reply(id: string, seconds: number): Message {
  return {
    message_id: id,
    role: 'TOOL',
    text: 'Here you go',
    timestamp: at(seconds),
    metadata: {
      toolCallId: `answer-${id}`,
      toolName: 'send_message_to_user',
      toolStatus: 'FINISHED',
      isUserAttentionMessage: true,
      attentionMessage: 'Here you go',
    },
  };
}

function makeCtx(overrides: Partial<AgentContextValue>): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: () => true,
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages: [],
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: true,
    ...overrides,
  } as AgentContextValue;
}

function renderList(ctx: AgentContextValue) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList showStatusBanners={false} />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

function searchRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-tool-name="web_search"]')];
}

describe('web search turn grouping', () => {
  it('renders a turn with searches across rounds as one row', async () => {
    const { container } = renderList(
      makeCtx({
        messages: [
          user('u1', 0, 'two cities?'),
          thought('r1', 1),
          search('s1', 2, 'paris weather', true),
          search('s2', 3, 'tokyo weather', true),
          thought('r2', 4),
          search('s3', 5, 'tokyo forecast', false),
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText('Searching 3 web searches')).toBeInTheDocument());
    const rows = searchRows(container);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-tool-status', 'IN_PROGRESS');
    expect(rows[0]).toHaveAttribute('data-web-search-count', '3');
    expect(screen.queryByText(/Web search completed for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Searching the web for/)).not.toBeInTheDocument();
  });

  it('finishes once every search is done and expands to every result', async () => {
    const { container } = renderList(
      makeCtx({
        messages: [
          user('u1', 0),
          thought('r1', 1),
          search('s1', 2, 'paris weather', true),
          thought('r2', 3),
          search('s2', 4, 'tokyo weather', true),
          thought('g1', 5),
          reply('a1', 6),
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText('Searched 2 web searches')).toBeInTheDocument());
    const [row] = searchRows(container);
    expect(row).toHaveAttribute('data-tool-status', 'FINISHED');
    fireEvent.click(screen.getByText('Searched 2 web searches'));
    await waitFor(() => {
      expect(screen.getByText(/result for paris weather/)).toBeInTheDocument();
      expect(screen.getByText(/result for tokyo weather/)).toBeInTheDocument();
    });
  });

  it('starts a new row for the next turn and keeps a single search as its own chip', async () => {
    const { container } = renderList(
      makeCtx({
        messages: [
          user('u1', 0),
          search('s1', 1, 'first', true),
          search('s2', 2, 'second', true),
          reply('a1', 3),
          user('u2', 4),
          search('s3', 5, 'third', true),
        ],
      }),
    );
    await waitFor(() => expect(screen.getByText('Searched 2 web searches')).toBeInTheDocument());
    expect(screen.getByText('Web search completed for third')).toBeInTheDocument();
    expect(searchRows(container)).toHaveLength(2);
  });

  it('folds a live search chip into the turn row instead of the list tail', async () => {
    renderList(
      makeCtx({
        messages: [user('u1', 0), search('s1', 1, 'paris weather', true), thought('r2', 2)],
        streamingTools: new Map([
          [
            'call-live',
            {
              stream_id: 'stream-2',
              tool_call_id: 'call-live',
              tool_name: 'web_search',
              title: '🔍 Searching the web for tokyo weather',
            },
          ],
        ]),
      }),
    );
    await waitFor(() => expect(screen.getByText('Searching 2 web searches')).toBeInTheDocument());
    expect(screen.queryByText(/Searching the web for tokyo weather/)).not.toBeInTheDocument();
  });

  it('shows a live search chip on its own when the turn has not searched yet', async () => {
    renderList(
      makeCtx({
        messages: [user('u1', 0)],
        streamingTools: new Map([
          [
            'call-live',
            {
              stream_id: 'stream-1',
              tool_call_id: 'call-live',
              tool_name: 'web_search',
              title: 'Searching the web for paris weather',
            },
          ],
        ]),
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Searching the web for paris weather/)).toBeInTheDocument(),
    );
  });

  it('releases the animation slot of a hidden search through the group row', async () => {
    const messages = [
      user('u1', 0),
      search('s1', 1, 'paris weather', true),
      search('s2', 2, 'tokyo weather', true),
    ];
    const onAnimationComplete = vi.fn();
    render(
      <TooltipProvider>
        <MessageListItems
          filteredMessages={messages}
          webSearchGrouping={groupWebSearchTurns(messages, [])}
          currentAnimatingId="s2"
          onAnimationComplete={onAnimationComplete}
          selectedAgentId="agent-1"
          exploreStepMap={new Map()}
          waitForCheckMap={new Map()}
          streamingMetricsBySubAgentId={new Map()}
        />
      </TooltipProvider>,
    );
    await waitFor(() => expect(onAnimationComplete).toHaveBeenCalled());
  });

  it('leaves sub-agent searches and other tools out of a group', () => {
    const sub = { ...search('s9', 3, 'sub query', true) };
    sub.metadata = { ...sub.metadata, subAgentId: 'child-1' };
    const grouping = groupWebSearchTurns(
      [
        user('u1', 0),
        search('s1', 1, 'a', true),
        sub,
        { ...reply('t1', 2), metadata: { toolName: 'grep', toolStatus: 'FINISHED' } },
        search('s2', 4, 'b', true),
      ],
      [],
    );
    expect(grouping.groupsByLeadId.size).toBe(0);
    expect(grouping.hiddenMessageIds.size).toBe(0);
  });
});
