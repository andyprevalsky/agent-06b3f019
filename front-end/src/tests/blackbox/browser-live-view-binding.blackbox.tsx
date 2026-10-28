/**
 * Owning-boundary coverage: the live view follows the task's backend session
 * binding, never a provider session the backend already released or the
 * provider already ended.
 *
 * Prod agent 8b4d4592 (2026-10-09, DoorDash refund), browser task e264ec23:
 *   - 20:32:07 the auth handoff named Steel f26ee1ab, which Steel had ended
 *     ~26h earlier; the refresh only moved the task to 201b22cb at 20:32:18.
 *   - 20:34:10 after "User Assistance Received" the panel fell back to the
 *     transcript's f26ee1ab although the row already pointed at live 201b22cb.
 *   - ~20:36:20 challenge recovery promoted Kernel pmHw1BNYtFaS and released
 *     201b22cb; the transcript only announced the new URL at 20:36:59.
 * In each window the user saw a closed session instead of the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/features/terminal-component-group/components/MessageList', () => {
  const MessageListStub = () => <div data-testid="message-list-stub" />;
  return { MessageList: MessageListStub, default: MessageListStub };
});
vi.mock('@/features/terminal-component-group/components/BrowserBorderGlow', () => ({
  default: () => null,
}));
vi.mock('@/features/terminal-component-group/components/BrowserCursorOverlay', () => ({
  default: () => null,
}));
vi.mock('@/components/ThinkingAnimation', () => ({
  default: () => null,
}));

import BrowserStatusBar from '@/features/terminal-component-group/components/BrowserStatusBar';
import { useBrowserStatusBarState } from '@/features/terminal-component-group/components/browser-status-bar/useBrowserStatusBarState';
import { AgentContext } from '@/features/agent-context';
import type { AgentContextValue } from '@/features/agent-context/types';
import { computeActiveBrowserPanels } from '@/features/terminal/hooks/derivations';
import type { Message } from '@/lib/api';
import {
  publishBrowserSessionBinding,
  type BrowserSessionBinding,
} from '@/lib/browserSessionBindings';

const API_BASE = 'http://localhost:3001/api';
const TASK_ID = 'e264ec23-538b-50bb-9874-30c9830a49d8';
const EXPIRED_STEEL =
  'https://connect.steel.dev/v1/sessions/f26ee1ab-f769-42d7-90a0-5d014fc1284f/player?interactive=false';
const REBOUND_STEEL =
  'https://connect.steel.dev/v1/sessions/201b22cb-e781-4527-95f5-fb1d8571ff89/player?interactive=false';
const PROMOTED_KERNEL =
  'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?readOnly=true';

function binding(
  debugUrl: string,
  asOf: number,
  overrides: Partial<BrowserSessionBinding> = {},
): BrowserSessionBinding {
  return {
    taskId: TASK_ID,
    sessionId: debugUrl,
    debugUrl,
    status: 'ACTIVE',
    live: true,
    asOf,
    ...overrides,
  };
}

function browserMessage(
  id: string,
  timestamp: string,
  metadata: Record<string, unknown>,
  text = '',
): Message {
  return {
    message_id: id,
    timestamp,
    text,
    role: 'TOOL',
    metadata: {
      toolName: 'spawn_browser_agent',
      task_id: TASK_ID,
      subAgentId: TASK_ID,
      ...metadata,
    },
  } as Message;
}

function agentContext(
  messages: Message[],
  agent: AgentContextValue['agent'] = null,
): AgentContextValue {
  return {
    agent,
    applyAgentDetail: vi.fn(() => true),
    selectedAgentId: '8b4d4592-c5da-4889-8a01-52824db125d1',
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
  };
}

/** Render exactly what the carousel renders: the transcript-derived panel URL. */
function statusBarFor(messages: Message[], agent: AgentContextValue['agent'] = null) {
  const panel = computeActiveBrowserPanels(messages).find((p) => p.taskId === TASK_ID);
  if (panel === undefined) throw new Error('browser panel is not active');
  return (
    <AgentContext.Provider value={agentContext(messages, agent)}>
      <BrowserStatusBar taskId={TASK_ID} browserUrl={panel.browserUrl} />
    </AgentContext.Provider>
  );
}

function liveIframe(): HTMLIFrameElement | null {
  return document.querySelector('iframe[title="Browser"]');
}

/** Serve GET .../live-view; returns the read counter. */
function serveLiveView(read: () => BrowserSessionBinding | Promise<BrowserSessionBinding>) {
  const reads = { count: 0 };
  server.use(
    http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, async ({ params }) => {
      expect(params.taskId).toBe(TASK_ID);
      reads.count += 1;
      return HttpResponse.json(await read());
    }),
  );
  return reads;
}

const sessionInit = (url: string) =>
  browserMessage(
    'init-1',
    '2026-10-08T18:20:26.721Z',
    {
      toolCallId: '9eb9b329-36a1-4c4c-a46d-5075cd87078c',
      toolStatus: 'FINISHED',
      action_type: 'session_init',
      title: 'Browser session ready',
      browser_url: url,
    },
    'Browser session connected and ready.',
  );

const authRequest = browserMessage('auth-req', '2026-10-08T18:32:07.839Z', {
  toolCallId: '95d0d04f5',
  toolStatus: 'IN_PROGRESS',
  action_type: 'auth_assistance',
  title: 'Requesting User Assistance for doordash.com Login',
  subAgentId: undefined,
  requestUserAuthentication: {
    taskId: TASK_ID,
    authRealm: 'doordash.com',
    requestId: 'ca2e2483-5a63-4697-ab50-8f3d8fcae5dc',
    browserUrl: EXPIRED_STEEL,
    handoffMode: 'same_steel_session_live_view',
    liveViewUrl: EXPIRED_STEEL.replace('interactive=false', 'interactive=true&showControls=true'),
  },
});

const authCompleted = browserMessage('auth-done', '2026-10-09T20:34:10.619Z', {
  toolCallId: '95d0d04f5',
  toolStatus: 'FINISHED',
  action_type: 'auth_assistance',
  title: 'User Assistance Received',
  subAgentId: undefined,
  requestUserAuthentication: {
    taskId: TASK_ID,
    authRealm: 'doordash.com',
    requestId: 'ca2e2483-5a63-4697-ab50-8f3d8fcae5dc',
    handoffMode: 'same_steel_session_live_view',
  },
});

describe('live view follows the backend session binding', () => {
  it('projects the latest accepted schema for the same browser task', () => {
    const firstSchema = {
      fields: [{ name: 'events', type: 'str', required: true, description: 'Events' }],
    };
    const latestSchema = {
      fields: [
        {
          name: 'auth_blocker',
          type: 'str',
          required: true,
          description: 'Authentication blocker',
        },
      ],
    };
    const messages = [
      {
        ...sessionInit(REBOUND_STEEL),
        metadata: { ...sessionInit(REBOUND_STEEL).metadata, output_schema: firstSchema },
      },
      browserMessage('schema-revision', '2026-10-14T17:33:50Z', { output_schema: latestSchema }),
    ];
    const { result } = renderHook(() => useBrowserStatusBarState(TASK_ID), {
      wrapper: ({ children }) => (
        <AgentContext.Provider value={agentContext(messages)}>{children}</AgentContext.Provider>
      ),
    });
    expect(result.current.outputSchema).toEqual(latestSchema);
  });
  let viewportWidth: number;
  beforeEach(() => {
    viewportWidth = window.innerWidth;
    const session = {
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'test-user', is_anonymous: false },
    };
    localStorage.setItem('rose-session', JSON.stringify(session));
    localStorage.setItem('app-user', JSON.stringify(session.user));
    // Fullscreen on mount — the same deep link the attention inbox opens.
    window.history.replaceState({}, '', `/?browser-id=${TASK_ID}`);
  });

  afterEach(() => {
    window.innerWidth = viewportWidth;
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it.each([
    { width: 390, state: 'active' },
    { width: 390, state: 'waiting' },
    { width: 390, state: 'disconnected' },
    { width: 1280, state: 'active' },
    { width: 1280, state: 'waiting' },
    { width: 1280, state: 'disconnected' },
  ])(
    'keeps foreign browser inspection read-only at width $width while $state',
    async ({ width, state }) => {
      window.innerWidth = width;
      const mutations: string[] = [];
      serveLiveView(() => binding(REBOUND_STEEL, 1));
      server.use(
        http.get(`${API_BASE}/browser-session/task/:taskId/control`, () =>
          HttpResponse.json({ state: 'requested', agentPaused: false, debugUrl: REBOUND_STEEL }),
        ),
        http.post(`${API_BASE}/browser-session/task/:taskId/control`, ({ request }) => {
          mutations.push(request.url);
          return HttpResponse.json({ state: 'user', agentPaused: false, debugUrl: REBOUND_STEEL });
        }),
        http.post(`${API_BASE}/auth-assistance/:requestId/:action`, ({ request }) => {
          mutations.push(request.url);
          return HttpResponse.json({ liveViewUrl: REBOUND_STEEL });
        }),
      );
      const messages = [sessionInit(REBOUND_STEEL)];
      if (state === 'waiting') messages.push(authRequest);
      if (state === 'disconnected') {
        messages.push(
          browserMessage('inspection-paused', '2026-10-14T17:33:50Z', {
            action_type: 'session_paused',
            toolStatus: 'FINISHED',
          }),
        );
      }
      const context = agentContext(messages);
      context.inspectionContext = {
        user_id: 'c49b4ce3-3489-499d-bfbd-846d04ba6275',
        name: 'Tamara',
        phone: null,
        email: null,
      };
      renderWithProviders(
        <AgentContext.Provider value={context}>
          <BrowserStatusBar taskId={TASK_ID} browserUrl={REBOUND_STEEL} />
        </AgentContext.Provider>,
      );

      await waitFor(() => expect(liveIframe()).toBeInTheDocument());
      fireEvent.load(liveIframe()!);
      expect(
        screen.queryByRole('button', { name: /^(Take control|Hand back control|Start Agent)$/i }),
      ).not.toBeInTheDocument();
      expect(liveIframe()).toHaveAttribute('inert');
      expect(liveIframe()).toHaveAttribute('tabindex', '-1');
      expect(liveIframe()?.src).toContain('interactive=false');
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 30));
      });
      expect(mutations).toEqual([]);
    },
  );

  it('does not recover browser control after an owned view becomes foreign inspection', async () => {
    let releaseRead: (() => void) | undefined;
    const mutations: string[] = [];
    serveLiveView(() => binding(REBOUND_STEEL, 1));
    server.use(
      http.get(`${API_BASE}/browser-session/task/:taskId/control`, async () => {
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return HttpResponse.json({
          state: 'requested',
          agentPaused: false,
          debugUrl: REBOUND_STEEL,
        });
      }),
      http.post(`${API_BASE}/browser-session/task/:taskId/control`, ({ request }) => {
        mutations.push(request.url);
        return HttpResponse.json({ state: 'user', agentPaused: false, debugUrl: REBOUND_STEEL });
      }),
    );
    const context = agentContext([sessionInit(REBOUND_STEEL)]);
    const view = (value: AgentContextValue) => (
      <AgentContext.Provider value={value}>
        <BrowserStatusBar taskId={TASK_ID} browserUrl={REBOUND_STEEL} />
      </AgentContext.Provider>
    );
    const rendered = renderWithProviders(view(context));
    await waitFor(() => expect(releaseRead).toBeDefined());
    rendered.rerender(
      view({
        ...context,
        inspectionContext: {
          user_id: 'c49b4ce3-3489-499d-bfbd-846d04ba6275',
          name: 'Tamara',
          phone: null,
          email: null,
        },
      }),
    );
    await act(async () => {
      releaseRead?.();
      await new Promise((resolve) => window.setTimeout(resolve, 30));
    });
    expect(mutations).toEqual([]);
  });

  it('shows the rebound session after auth assistance, not the expired transcript session', async () => {
    serveLiveView(() => binding(REBOUND_STEEL, 1));

    renderWithProviders(statusBarFor([sessionInit(EXPIRED_STEEL), authRequest, authCompleted]));

    await waitFor(() => expect(liveIframe()?.src).toBe(REBOUND_STEEL));
  });

  it('switches to the promoted session as soon as challenge recovery broadcasts the rebind', async () => {
    serveLiveView(() => binding(REBOUND_STEEL, 1));
    const messages = [
      sessionInit(REBOUND_STEEL),
      browserMessage('recovery-search', '2026-10-09T20:36:16.973Z', {
        toolCallId: 'recovery-1',
        toolStatus: 'IN_PROGRESS',
        action_type: 'browser_challenge_recovery',
        recoveryStage: 'browser_config_search',
        title: 'Searching browser configurations',
        browser_url: REBOUND_STEEL,
      }),
    ];

    renderWithProviders(statusBarFor(messages));
    await waitFor(() => expect(liveIframe()?.src).toBe(REBOUND_STEEL));

    // Backend promote: row rebound to the Kernel winner and BROWSER_SESSION
    // broadcast before Steel 201b22cb is released. No transcript message yet.
    act(() => publishBrowserSessionBinding(binding(PROMOTED_KERNEL, 2)));

    expect(liveIframe()?.src).toBe(PROMOTED_KERNEL);
    expect(screen.getByTestId('live-view-loading')).toBeInTheDocument();
    fireEvent.load(liveIframe()!);
    expect(screen.queryByTestId('live-view-loading')).toBeNull();
  });

  it('shows a loading screen, not the ended handoff session, until the refreshed binding arrives', async () => {
    let releaseRefresh: (() => void) | null = null;
    server.use(
      http.post(`${API_BASE}/auth-assistance/:id/refresh-session`, async () => {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
        return HttpResponse.json({ refreshed: true });
      }),
    );
    // The row still names f26ee1ab, but Steel reports it released.
    serveLiveView(() => binding(EXPIRED_STEEL, 1, { live: false }));

    renderWithProviders(statusBarFor([sessionInit(EXPIRED_STEEL), authRequest]));

    await waitFor(() => expect(screen.getByTestId('live-view-loading')).toBeInTheDocument());
    expect(liveIframe()).toBeNull();
    // The overlay sits under the handoff controls.
    expect(screen.getByRole('button', { name: 'Start Agent' })).toBeVisible();

    // Refresh resumed the task on 201b22cb and the backend broadcast the rebind.
    act(() => publishBrowserSessionBinding(binding(REBOUND_STEEL, 2)));
    expect(liveIframe()?.src).toBe(
      'https://connect.steel.dev/v1/sessions/201b22cb-e781-4527-95f5-fb1d8571ff89/player?interactive=true&showControls=true',
    );
    releaseRefresh?.();
  });

  it.each(['COMPLETED', 'FAILED'] as const)(
    'shows a terminal state, never "Connecting…", for a %s agent whose task never recorded an end',
    async (status) => {
      // Leftover card: the session_init is the task's last message (no end/result),
      // and the binding read still reports the provider session as live.
      serveLiveView(() => binding(PROMOTED_KERNEL, 1));
      const finished = {
        agent_id: '8b4d4592-c5da-4889-8a01-52824db125d1',
        status,
      } as NonNullable<AgentContextValue['agent']>;
      renderWithProviders(statusBarFor([sessionInit(PROMOTED_KERNEL)], finished));

      await waitFor(() =>
        expect(screen.getAllByTestId('live-view-ended').length).toBeGreaterThan(0),
      );
      expect(screen.queryByTestId('live-view-loading')).toBeNull();
      expect(screen.queryByText(/Connecting/)).toBeNull();
      expect(document.querySelector('iframe')).toBeNull();
    },
  );

  it('shows the ended state on the stock (non-desktop) browser card too', async () => {
    serveLiveView(() => binding(PROMOTED_KERNEL, 1));
    const finished = {
      agent_id: '8b4d4592-c5da-4889-8a01-52824db125d1',
      status: 'COMPLETED',
    } as NonNullable<AgentContextValue['agent']>;
    renderWithProviders(statusBarFor([sessionInit(PROMOTED_KERNEL)], finished), {
      roseDesktop: false,
    });
    await waitFor(() => expect(screen.getAllByTestId('live-view-ended').length).toBeGreaterThan(0));
    expect(screen.queryByText(/Connecting/)).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it.each(['ACTIVE', 'OUT_OF_CREDITS'] as const)(
    'keeps the live stream for a %s (resumable) agent',
    async (status) => {
      serveLiveView(() => binding(PROMOTED_KERNEL, 1));
      const running = {
        agent_id: '8b4d4592-c5da-4889-8a01-52824db125d1',
        status,
      } as NonNullable<AgentContextValue['agent']>;
      renderWithProviders(statusBarFor([sessionInit(PROMOTED_KERNEL)], running));
      await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
      expect(screen.queryByTestId('live-view-ended')).toBeNull();
    },
  );

  it('replaces the stream with the loading screen when the bound session closes', async () => {
    serveLiveView(() => binding(PROMOTED_KERNEL, 1));
    renderWithProviders(statusBarFor([sessionInit(PROMOTED_KERNEL)]));
    await waitFor(() => expect(liveIframe()?.src).toBe(PROMOTED_KERNEL));

    act(() =>
      publishBrowserSessionBinding(binding(PROMOTED_KERNEL, 2, { status: 'CLOSED', live: false })),
    );

    expect(liveIframe()).toBeNull();
    expect(screen.getByTestId('live-view-loading')).toBeInTheDocument();
  });

  it('keeps a broadcast rebind when an older live-view read resolves later', async () => {
    let releaseRead: (() => void) | null = null;
    serveLiveView(
      () =>
        new Promise<BrowserSessionBinding>((resolve) => {
          // Read the row before the promote committed.
          releaseRead = () => resolve(binding(REBOUND_STEEL, 1));
        }),
    );

    renderWithProviders(statusBarFor([sessionInit(REBOUND_STEEL)]));
    await waitFor(() => expect(releaseRead).not.toBeNull());
    act(() => publishBrowserSessionBinding(binding(PROMOTED_KERNEL, 2)));
    expect(liveIframe()?.src).toBe(PROMOTED_KERNEL);

    await act(async () => {
      releaseRead?.();
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(liveIframe()?.src).toBe(PROMOTED_KERNEL);
  });

  it('streams the bound session in the minimized thumbnail as well', async () => {
    window.history.replaceState({}, '', '/');
    serveLiveView(() => binding(REBOUND_STEEL, 1));

    renderWithProviders(statusBarFor([sessionInit(EXPIRED_STEEL), authRequest, authCompleted]));

    await waitFor(() =>
      expect(document.querySelector('iframe[title="Preview"]')).toHaveAttribute(
        'src',
        REBOUND_STEEL,
      ),
    );
  });

  it('gives the user the interactive view of the bound session on take control', async () => {
    serveLiveView(() => binding(PROMOTED_KERNEL, 1));
    server.use(
      http.post(`${API_BASE}/browser-session/task/:taskId/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
          debugUrl: PROMOTED_KERNEL,
        });
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(statusBarFor([sessionInit(REBOUND_STEEL)]));
    await waitFor(() => expect(liveIframe()?.src).toBe(PROMOTED_KERNEL));

    await user.click(await screen.findByRole('button', { name: 'Take control' }));

    await waitFor(() =>
      expect(liveIframe()?.src).toBe(
        'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?interactive=true&showControls=true',
      ),
    );
  });

  it('resumes onto the rebound session even while a pre-resume read is in flight', async () => {
    let releaseStaleRead: (() => void) | null = null;
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/browser-session/task/:taskId/live-view`, async () => {
        reads += 1;
        if (reads === 1) {
          // Mount read of the paused row, still in flight when the user resumes.
          await new Promise<void>((resolve) => {
            releaseStaleRead = resolve;
          });
          return HttpResponse.json(binding(REBOUND_STEEL, 1, { status: 'PAUSED', live: false }));
        }
        return HttpResponse.json(binding(PROMOTED_KERNEL, 3));
      }),
      http.post(`${API_BASE}/browser-session/resume`, () =>
        HttpResponse.json({ success: true, debug_url: PROMOTED_KERNEL }),
      ),
      http.post(`${API_BASE}/browser-session/task/:taskId/control`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        return HttpResponse.json({
          state: body.mode === 'user' ? 'user' : 'agent',
          agentPaused: false,
          debugUrl: PROMOTED_KERNEL,
        });
      }),
    );
    const paused = browserMessage('paused', '2026-10-09T20:40:00.000Z', {
      toolCallId: 'pause-1',
      toolStatus: 'FINISHED',
      action_type: 'session_paused',
      title: 'Paused',
    });
    const user = userEvent.setup();
    renderWithProviders(
      <AgentContext.Provider value={agentContext([sessionInit(REBOUND_STEEL), paused])}>
        <BrowserStatusBar taskId={TASK_ID} browserUrl={REBOUND_STEEL} />
      </AgentContext.Provider>,
    );
    await waitFor(() => expect(releaseStaleRead).not.toBeNull());

    await user.click(await screen.findByRole('button', { name: 'Take Control' }));

    await waitFor(() =>
      expect(liveIframe()?.src).toBe(
        'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?interactive=true&showControls=true',
      ),
    );
    await act(async () => {
      releaseStaleRead?.();
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    });
    expect(liveIframe()?.src).toContain('pmHw1BNYtFaS');
  });
});
