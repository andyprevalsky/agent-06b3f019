/** Permanent browser-panel lifecycle and actual Open Browser click replay for agent 3392. */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import BrowserStatusBarCarousel from '@/features/terminal-component-group/components/BrowserStatusBarCarousel';
import MessageBubble from '@/features/terminal-component-group/components/MessageBubble';
import { computeActiveBrowserPanels } from '@/lib/browserPanelLifecycle';
import type { Message } from '@/lib/api';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';
import reopenedBrowserTranscriptJson from './browser-reopened-session.fixture.json';

const API = 'http://localhost:3001/api';
const BOUND_URL = 'https://live.example/root-bound';

function agentContext(agentId: string): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: agentId,
    setSelectedAgentId: vi.fn(),
    messages: [],
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    streamingTools: new Map(),
    streamedTextsRef: { current: new Set<string>() },
    registerMessageHandler: vi.fn(() => () => {}),
    sendMessage: vi.fn(async () => {}),
    isLoadingAgent: false,
    forceResubscribe: vi.fn(),
    isChatMode: false,
    inspectionContext: null,
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => false),
    stageUserMessage: vi.fn(() => ({ confirm: vi.fn(), drop: vi.fn() })),
  };
}

describe('persistent browser session lifecycle', () => {
  beforeEach(() => mockSession());

  it('reopens a persistent browser task for its current invocation after an earlier completion', () => {
    // Captured agent 3392: the same BrowserSession row is reused by a later
    // spawn call. Old task_complete events must not hide its auth handoff.
    const messages = reopenedBrowserTranscriptJson as Message[];
    expect(computeActiveBrowserPanels(messages)).toEqual([
      {
        taskId: 'e62f18ac-84fd-51c5-90d4-a2abf4c4eb09',
        browserUrl: 'https://browser.example/live/current',
      },
    ]);
    expect(computeActiveBrowserPanels([...messages].reverse())).toEqual(
      computeActiveBrowserPanels(messages),
    );
  });

  it('ignores a late terminal from the previous invocation but closes the current one', () => {
    const messages = reopenedBrowserTranscriptJson as Message[];
    const previousTerminal = messages[3];
    const lateTerminal: Message = {
      ...previousTerminal,
      message_id: 'late-previous-terminal',
      timestamp: '2026-10-27T02:45:00.000Z',
    };
    expect(computeActiveBrowserPanels([...messages, lateTerminal])).toHaveLength(1);
    const currentTerminal: Message = {
      ...lateTerminal,
      message_id: 'current-terminal',
      metadata: { ...lateTerminal.metadata, toolCallId: 'dbf27293d' },
    };
    expect(computeActiveBrowserPanels([...messages, lateTerminal, currentTerminal])).toEqual([]);
  });

  it('reopens a paused invocation on session_init but not on verifier or cleanup events', () => {
    const init = (reopenedBrowserTranscriptJson as Message[])[0];
    const paused: Message = {
      ...init,
      message_id: 'paused',
      timestamp: '2026-10-27T01:37:00.000Z',
      metadata: { ...init.metadata, action_type: 'session_paused' },
    };
    const next: Message = {
      ...init,
      message_id: 'next',
      timestamp: '2026-10-27T01:38:00.000Z',
      metadata: { ...init.metadata, action_type: 'session_init' },
    };
    expect(computeActiveBrowserPanels([init, paused, next])).toHaveLength(1);
    for (const action_type of [
      'system',
      'recording',
      'network_recording',
      'diagnostics',
    ] as const) {
      expect(
        computeActiveBrowserPanels([
          init,
          paused,
          { ...next, metadata: { ...next.metadata, action_type } },
        ]),
      ).toEqual([]);
    }
  });

  it('Open Browser opens the bound viewer after a persistent task is reused', async () => {
    const messages = reopenedBrowserTranscriptJson as Message[];
    const taskId = 'e62f18ac-84fd-51c5-90d4-a2abf4c4eb09';
    const context = { ...agentContext('agent-reopened'), messages };
    server.use(
      http.get(`${API}/browser-session/task/${taskId}/live-view`, () =>
        HttpResponse.json({
          taskId,
          sessionId: 'current-session',
          debugUrl: BOUND_URL,
          status: 'ACTIVE',
          live: true,
          asOf: Date.now(),
        }),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(
      <AgentContext.Provider value={context}>
        <div data-testid="reopened-auth-message">
          <MessageBubble message={messages[messages.length - 1]} />
        </div>
        <BrowserStatusBarCarousel browsers={computeActiveBrowserPanels(messages)} />
      </AgentContext.Provider>,
      { selectedAgentId: 'agent-reopened' },
    );
    await user.click(
      within(screen.getByTestId('reopened-auth-message')).getByRole('button', {
        name: 'Open Browser',
      }),
    );
    expect(screen.getByTestId('browser-app-drawer')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('browser-tab-agent-reopened')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(screen.getByTitle('Browser')).toHaveAttribute(
        'src',
        `${BOUND_URL}?interactive=true&showControls=true`,
      ),
    );
    expect(capturedRequests.some((r) => r.url.endsWith(`/task/${taskId}/live-view`))).toBe(true);
  });
});
