/**
 * Blackbox coverage for mobile-only message entry animation suppression.
 */
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context';
import { MessageList } from '@/features/terminal-component-group/components/MessageList';
import type { Message } from '@/lib/api';

function makeAgentCtx(overrides: Partial<AgentContextValue> = {}): AgentContextValue {
  const streamedTextsRef = { current: new Set<string>() } as React.MutableRefObject<Set<string>>;
  return {
    agent: null,
    applyAgentDetail: () => true,
    inspectionContext: null,
    stagePendingAgentCreation: () => {},
    reconcilePendingAgentCreation: async () => {},
    rollbackPendingAgentCreation: () => false,
    stageUserMessage: () => ({ confirm: () => {}, drop: () => {} }),
    selectedAgentId: 'agent-1',
    setSelectedAgentId: () => {},
    messages: [],
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef,
    registerMessageHandler: () => () => {},
    sendMessage: async () => {},
    isLoadingAgent: false,
    forceResubscribe: () => {},
    isChatMode: false,
    ...overrides,
  };
}

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    message_id: id,
    timestamp: new Date().toISOString(),
    role: 'USER',
    text: id,
    ...overrides,
  };
}

function renderList(ctx: AgentContextValue) {
  return render(
    <AgentContext.Provider value={ctx}>
      <TooltipProvider>
        <MessageList />
      </TooltipProvider>
    </AgentContext.Provider>,
  );
}

describe('MessageList mobile animation scope', () => {
  it('scopes mobile entry-animation suppression to direct message popup roots', () => {
    const ctx = makeAgentCtx({
      messages: [msg('u1', { role: 'USER', text: 'question?' })],
    });
    const { container } = renderList(ctx);
    const list = container.firstElementChild as HTMLElement | null;
    const popupRoot = container.querySelector(
      '[data-message-id="u1"] > .animate-in.fade-in.duration-300',
    );

    expect(list).not.toBeNull();
    expect(list?.classList.contains('mobile-disable-message-entry-spawn')).toBe(true);
    expect(popupRoot).not.toBeNull();
  });
});
