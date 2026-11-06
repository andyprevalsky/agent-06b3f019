/** Browser task identity and labels across multiple sessions owned by one agent. */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browserTaskLabel } from '@/features/terminal-component-group/components/rose-apps/browserTaskLabel';
import BrowserStatusBarCarousel from '@/features/terminal-component-group/components/BrowserStatusBarCarousel';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';
import { renderWithProviders } from './test-wrapper';
function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function agentContext(messages: Message[], agentId: string): AgentContextValue {
  return {
    agent: null,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: agentId,
    setSelectedAgentId: vi.fn(),
    messages,
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

function withAgent(messages: Message[], agentId: string, children: React.ReactNode) {
  return (
    <AgentContext.Provider value={agentContext(messages, agentId)}>
      {children}
    </AgentContext.Provider>
  );
}

describe('multiple browser tasks', () => {
  beforeEach(() => mockSession());
  it('keeps sibling browser tasks selectable in the chip and drawer with task-name subtitles', async () => {
    const user = userEvent.setup();
    // Captured production owner/task relationship from 43082b47: browser init
    // shares the original toolCallId with its hidden background spawn row.
    const tasks = [
      {
        taskId: 'hat-task',
        callId: '6411642c7',
        path: '/root/buy_black_cowboy_hat',
        label: 'Buy black cowboy hat',
        url: 'https://www.amazon.com/hat',
      },
      {
        taskId: 'bandana-task',
        callId: 'call_ae34f0a2c8964f0aa71b17ee',
        path: '/root/buy_bandana_gun',
        label: 'Buy bandana gun',
        url: 'https://www.amazon.com/bandana',
      },
    ];
    const messages: Message[] = tasks.flatMap((task, index) => [
      {
        message_id: `spawn-${index}`,
        timestamp: `2026-10-27T04:30:0${index}Z`,
        role: 'TOOL',
        text: '',
        metadata: {
          toolName: 'spawn_agent',
          toolCallId: task.callId,
          toolStatus: 'FINISHED',
          hidden: true,
          runInBackground: true,
          backgroundAgentType: 'browser',
          backgroundPath: task.path,
        },
      },
      {
        message_id: `init-${index}`,
        timestamp: `2026-10-27T04:31:0${index}Z`,
        role: 'TOOL',
        text: '',
        metadata: {
          toolName: 'spawn_browser_agent',
          toolCallId: task.callId,
          task_id: task.taskId,
          action_type: 'browser',
          toolStatus: 'IN_PROGRESS',
          browser_url: 'about:blank',
        },
      },
      {
        message_id: `step-${index}`,
        timestamp: `2026-10-27T04:32:0${index}Z`,
        role: 'TOOL',
        text: '',
        metadata: {
          toolName: 'spawn_browser_agent',
          task_id: task.taskId,
          action_type: 'click',
          title: `Working on ${task.taskId}`,
          auxiliary: { current_url: task.url },
        },
      },
    ]);
    const view = (rows: Message[], browsers = tasks) =>
      withAgent(
        rows,
        'agent-a',
        <BrowserStatusBarCarousel
          browsers={browsers.map((task) => ({ taskId: task.taskId, browserUrl: 'about:blank' }))}
        />,
      );
    const { rerender } = renderWithProviders(view(messages), { selectedAgentId: 'agent-a' });
    act(() =>
      window.dispatchEvent(
        new CustomEvent('navi-open-browser', { detail: { taskId: 'bandana-task' } }),
      ),
    );
    const drawer = screen.getByTestId('browser-app-drawer');
    const tabs = within(drawer).getByRole('tablist', { name: 'Browser tabs' });
    const hat = within(tabs).getByRole('tab', { name: /Buy black cowboy hat/ });
    const bandana = within(tabs).getByRole('tab', { name: /Buy bandana gun/ });
    expect(bandana).toHaveAttribute('aria-selected', 'true');
    expect(within(bandana).getByTestId('browser-task-label')).toHaveTextContent('Buy bandana gun');
    expect(within(bandana).getByTestId('browser-task-label').querySelector('svg')).not.toBeNull();
    expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent('/bandana');
    expect(within(drawer).getAllByTestId('browser-agent-pane')).toHaveLength(1);
    await user.click(hat);
    expect(hat).toHaveAttribute('aria-selected', 'true');
    expect(bandana).toHaveAttribute('aria-selected', 'false');
    expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent('/hat');
    expect(within(drawer).getByTestId('browser-composer-slot')).toHaveAttribute(
      'data-task-id',
      'hat-task',
    );
    expect(
      screen.getByRole('button', { name: 'Show browser: Buy black cowboy hat' }),
    ).toBeInTheDocument();
    // A sibling's metadata refresh must not steal the selected pane.
    rerender(
      view([
        ...messages,
        {
          ...messages[5],
          message_id: 'update',
          timestamp: '2026-10-27T04:33:00Z',
          metadata: {
            ...messages[5].metadata,
            auxiliary: { current_url: 'https://www.amazon.com/bandana/new' },
          },
        },
      ]),
    );
    expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent('/hat');
    await user.click(within(tabs).getByRole('tab', { name: /Buy bandana gun/ }));
    expect(within(drawer).getByTestId('browser-address-bar')).toHaveTextContent('/bandana/new');
    // Ending one sibling removes only its tab, preserving the other task.
    rerender(view(messages, [tasks[0]]));
    await waitFor(() =>
      expect(within(tabs).queryByRole('tab', { name: /Buy bandana gun/ })).toBeNull(),
    );
    expect(within(tabs).getByRole('tab', { name: /Buy black cowboy hat/ })).toBeInTheDocument();
  });
  it('keeps an explicit task selection after a deep link and later browser updates', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/?browser-id=first');
    const messages: Message[] = ['first', 'second'].flatMap((taskId) => [
      {
        message_id: `spawn-${taskId}`,
        timestamp: '2026-10-27T00:00:00Z',
        role: 'TOOL',
        text: '',
        metadata: { toolCallId: taskId, backgroundPath: `/root/${taskId}` },
      },
      {
        message_id: `init-${taskId}`,
        timestamp: '2026-10-27T00:01:00Z',
        role: 'TOOL',
        text: '',
        metadata: {
          toolCallId: taskId,
          task_id: taskId,
          action_type: 'browser',
          toolName: 'spawn_browser_agent',
          browser_url: 'about:blank',
        },
      },
    ]);
    const view = (url: string) =>
      withAgent(
        messages,
        'agent-a',
        <BrowserStatusBarCarousel
          browsers={[
            { taskId: 'first', browserUrl: 'about:blank' },
            { taskId: 'second', browserUrl: url },
          ]}
        />,
      );
    try {
      const { rerender } = renderWithProviders(view('about:blank'), { selectedAgentId: 'agent-a' });
      expect(screen.getByRole('button', { name: 'Show browser: First' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await user.click(screen.getByRole('button', { name: 'Show browser: Second' }));
      rerender(view('about:blank#updated'));
      expect(screen.getByRole('button', { name: 'Show browser: Second' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });
  it('keeps task names tied to initialization when step messages arrive before older rows', () => {
    const messages: Message[] = [
      {
        message_id: 'step',
        timestamp: '2026-10-27T00:02:00Z',
        role: 'TOOL',
        text: '',
        metadata: { task_id: 'task', toolCallId: 'native-action', action_type: 'click' },
      },
      {
        message_id: 'init',
        timestamp: '2026-10-27T00:01:00Z',
        role: 'TOOL',
        text: '',
        metadata: { task_id: 'task', toolCallId: 'spawn-call', action_type: 'browser' },
      },
      {
        message_id: 'spawn',
        timestamp: '2026-10-27T00:00:00Z',
        role: 'TOOL',
        text: '',
        metadata: { toolCallId: 'spawn-call', backgroundPath: '/root/buy_black_cowboy_hat' },
      },
    ];
    messages.unshift({
      message_id: 'session-init',
      timestamp: '2026-10-27T00:01:01Z',
      role: 'TOOL',
      text: '',
      metadata: { task_id: 'task', toolCallId: 'generated-call', action_type: 'session_init' },
    });
    expect(browserTaskLabel(messages, 'task')).toBe('Buy black cowboy hat');
    expect(browserTaskLabel([...messages].reverse(), 'task')).toBe('Buy black cowboy hat');
  });
});
