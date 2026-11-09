/** Reduced events from agent 4f77a454: full metadata then same-session reattach. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import type { Message } from '@/lib/api';
import { useBrowserStatusBarState } from '@/features/terminal-component-group/components/browser-status-bar/useBrowserStatusBarState';
import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';
import { useRoseApps } from '@/features/terminal-component-group/components/rose-apps/roseAppsState';
import { renderWithProviders } from './test-wrapper';
import { agentBrowser, openBrowserDrawer, settle } from './rose-apps-root-browser.fixtures';
import { mockTerminalHookSession } from './terminal-hooks.fixtures';
import { server } from './msw/server';

const TASK = '8d3b7e9c-9002-507b-92b2-f962280eab9b';
const URL_A = 'https://connect.steel.dev/v1/sessions/session-a/player/test?interactive=false';
const URL_B = 'https://connect.steel.dev/v1/sessions/session-b/player/test?interactive=false';
const FULL = {
  provider: 'steel',
  profile_id: 'profile-a',
  proxy_source: 'steel',
  proxy_location: { city: 'SAN FRANCISCO', state: 'CA', country: 'US' },
};
const PARTIAL = { provider: 'steel', profile_id: 'profile-a', steel_profile_id: 'profile-a' };
function event(id: string, timestamp: string, url: string, metadata: object): Message {
  return {
    message_id: id,
    timestamp,
    text: '',
    role: 'TOOL',
    metadata: {
      task_id: TASK,
      subAgentId: TASK,
      toolName: 'spawn_browser_agent',
      action_type: 'session_init',
      browser_url: url,
      browser_session_metadata: metadata,
    },
  } as Message;
}
function wrapper(messages: Message[]) {
  const value = {
    messages,
    inspectionContext: null,
    registerMessageHandler: vi.fn(() => () => {}),
  } as unknown as AgentContextValue;
  return ({ children }: { children: ReactNode }) => (
    <AgentContext.Provider value={value}>{children}</AgentContext.Provider>
  );
}

const PENDING_AGENT = 'agent-a';
/** Reads the real RoseApps selection and drives its pending-switch transitions. */
function SelectionProbe() {
  const apps = useRoseApps();
  if (apps === null) return null;
  return (
    <>
      <output data-testid="browser-selection">{`${apps.browserTabAgentId}:${apps.browserTabTaskId}`}</output>
      <button type="button" onClick={() => apps.openAgentBrowserTab(PENDING_AGENT)}>
        open agent tab
      </button>
      <button type="button" onClick={() => apps.openAgentBrowser(PENDING_AGENT, 'task-1')}>
        open task 1
      </button>
      <button
        type="button"
        onClick={() =>
          apps.registerAgentBrowser({ agentId: PENDING_AGENT, taskId: 'task-2', live: true })
        }
      >
        register task 2
      </button>
    </>
  );
}

describe('Browser session presentation regressions', () => {
  beforeEach(() => mockTerminalHookSession());
  it('same-session reattach retains known proxy metadata', () => {
    const messages = [
      event('init', '2026-11-06T02:15:08.907Z', URL_A, FULL),
      event('reattach', '2026-11-06T02:24:04.689Z', URL_A, PARTIAL),
    ];
    const { result } = renderHook(() => useBrowserStatusBarState(TASK), {
      wrapper: wrapper(messages),
    });
    expect(result.current.browserSessionMetadata).toMatchObject(FULL);
  });
  it.each([
    [URL_A, URL_A.replace('/player/test?', '/player/reminted?')],
    [
      'https://back.tilion.dev/v1/session/sess_a/live-view?token=old',
      'https://back.tilion.dev/v1/session/sess_a/live-view?token=new',
    ],
    [
      'https://prod.kernel.sh/browser/live/session-a?readOnly=true',
      'https://prod.kernel.sh/browser/live/session-a?interactive=true',
    ],
  ])(
    'retains proxy metadata when only a viewer token or control flag changes: %s',
    (before, after) => {
      const messages = [
        event('init', '2026-11-06T02:15:08.907Z', before, FULL),
        event('reattach', '2026-11-06T02:24:04.689Z', after, PARTIAL),
      ];
      const { result } = renderHook(() => useBrowserStatusBarState(TASK), {
        wrapper: wrapper(messages),
      });
      expect(result.current.browserSessionMetadata).toMatchObject(FULL);
    },
  );
  it('a replacement session never inherits the old exit location', () => {
    const messages = [
      event('init', '2026-11-06T02:15:08.907Z', URL_A, FULL),
      event('replacement', '2026-11-06T02:33:13.842Z', URL_B, PARTIAL),
    ];
    const { result } = renderHook(() => useBrowserStatusBarState(TASK), {
      wrapper: wrapper(messages),
    });
    expect(result.current.browserSessionMetadata?.proxy_location).toBeUndefined();
  });
  it('an open drawer adopts the selected agent browser when its messages arrive later', async () => {
    const agent = '4f77a454-7ee9-449d-9803-175056487f9e';
    server.use(
      http.get('http://localhost:3001/api/browser-session/task/task-1/live-view', () =>
        HttpResponse.json({
          taskId: 'task-1',
          sessionId: 'session-a',
          debugUrl: URL_A,
          status: 'ACTIVE',
          live: true,
          asOf: Date.now(),
        }),
      ),
    );
    const user = userEvent.setup();
    const view = renderWithProviders(<RoseAppIcons />, { selectedAgentId: agent });
    const drawer = await openBrowserDrawer(user);
    expect(within(drawer).getByTestId('browser-no-session')).toBeInTheDocument();
    view.rerender(
      <>
        <RoseAppIcons />
        {agentBrowser(agent)}
      </>,
    );
    await settle();
    await waitFor(() => expect(within(drawer).queryByTestId('browser-no-session')).toBeNull());
    await waitFor(() => expect(within(drawer).getByTitle('Browser')).toHaveAttribute('src', URL_A));
    expect(screen.getByTestId(`browser-tab-${agent}`)).toHaveAttribute('aria-selected', 'true');
  });
  it.each([
    ['selecting the agent', false],
    ['openAgentBrowserTab', true],
  ])(
    'an explicitly opened task keeps the selection when a pending switch (from %s) sees another task register',
    async (_source, viaAgentTab) => {
      const user = userEvent.setup();
      // The selected agent has no registered tab yet, so its switch is pending.
      renderWithProviders(<SelectionProbe />, { selectedAgentId: PENDING_AGENT });
      if (viaAgentTab) await user.click(screen.getByRole('button', { name: 'open agent tab' }));
      expect(screen.getByTestId('browser-selection')).toHaveTextContent('null:null');
      await user.click(screen.getByRole('button', { name: 'open task 1' }));
      expect(screen.getByTestId('browser-selection')).toHaveTextContent(`${PENDING_AGENT}:task-1`);
      await user.click(screen.getByRole('button', { name: 'register task 2' }));
      expect(screen.getByTestId('browser-selection')).toHaveTextContent(`${PENDING_AGENT}:task-1`);
    },
  );
});
