/** Shared Browser drawer / Root browser fixtures (backend contract: domains/browser-world). */
import React from 'react';
import { vi, expect } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';
import type { RootBrowserView, RootSiteView } from '@/lib/api/browser-world';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';

export const API = 'http://localhost:3001/api';
export const WORLD = `${API}/browser-world`;
export const WRAPPER_CLASS = /\b(border|bg-|rounded|ring|shadow)/;
export const BOUND_URL = 'https://live.example/root-bound';

export const ROOT: RootBrowserView = {
  task_id: 'root-task',
  session_id: 'sess-root',
  status: 'ACTIVE',
  provider: 'kernel',
  live_view_url: 'https://live.example/root-transcript',
  forked_sites: 2,
  live_view_path: '/api/browser-session/task/root-task/live-view',
  control_path: '/api/browser-session/task/root-task/control',
};

export const ACTION: Message = {
  message_id: 'm-1',
  timestamp: '2026-01-01T00:00:00Z',
  text: '',
  role: 'TOOL',
  metadata: { task_id: 'task-1', action_type: 'click', title: 'Clicking around' },
};

export function agentContext(agentId: string): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: agentId,
    setSelectedAgentId: vi.fn(),
    messages: [ACTION],
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
  };
}

export function agentBrowser(agentId = 'agent-a') {
  return (
    <AgentContext.Provider value={agentContext(agentId)}>
      <BrowserStatusBar taskId="task-1" browserUrl="about:blank" />
    </AgentContext.Provider>
  );
}

/** "METHOD /path" of every browser-world request so far. */
export function worldRequests(): string[] {
  return capturedRequests
    .filter((r) => r.url.includes('/browser-world/'))
    .map((r) => `${r.method} ${new URL(r.url).pathname}`);
}

export function rootRequests(): string[] {
  return capturedRequests
    .filter((r) => r.url.includes('/browser-session/task/root-task/'))
    .map((r) => `${r.method} ${new URL(r.url).pathname.replace('/api/browser-session/task/', '')}`);
}

/** Let any request a render could start reach MSW. */
export async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

export function serveRoot(root: () => RootBrowserView | null, sites: RootSiteView[] = []) {
  server.use(
    http.get(`${WORLD}/root`, () => HttpResponse.json({ root: root(), sites })),
    http.get(`${API}/browser-session/task/root-task/live-view`, () =>
      HttpResponse.json({
        taskId: 'root-task',
        sessionId: 'sess-root',
        debugUrl: BOUND_URL,
        status: 'ACTIVE',
        live: true,
        asOf: Date.now(),
      }),
    ),
  );
}

export async function openBrowserDrawer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId('rose-app-browser'));
  const drawer = screen.getByTestId('browser-app-drawer');
  expect(drawer).toHaveAttribute('data-state', 'open');
  return drawer;
}

export async function boundRootFrame(pane: HTMLElement) {
  await waitFor(() =>
    expect(within(pane).getByTitle('Root browser')).toHaveAttribute('src', BOUND_URL),
  );
  return within(pane).getByTitle('Root browser');
}
