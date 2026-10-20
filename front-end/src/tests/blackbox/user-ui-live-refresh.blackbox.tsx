/**
 * Live refresh of the per-user UI (features/user-ui) while a session is open.
 *
 * STATE MACHINE (under test):
 *   [ACTIVE v1] --open agent / its sub-agent: new message or status change-->
 *   [REFRESH PENDING] (one GET /api/user-ui/active per 750ms window, deduped)
 *   [REFRESH PENDING] --newer versionId--> [ACTIVE v2] (applied in place, no
 *   page reload, no remount)
 *   [REFRESH PENDING] --unmount--> cancelled (no request)
 *   `user_ui.published` event / refreshActiveUserUi() --> [REFRESH PENDING]
 *
 * Regression for the recorded run where a code agent published mid-session and
 * nothing changed until a reload
 * (.context/rose-real-recordings/run3/logs/flow2-evidence.txt).
 *
 * Whole-app theme/background/slots are removed (UI ledger row 89): the probe
 * reads the applied versionId, and a refreshed manifest that still names a
 * theme or slots never fetches theme.json or renders a background.
 *
 * Realtime transport is the chat's existing per-agent channel (and the
 * sub-agent tree's existing bus): the tests capture those handlers and assert
 * no extra channel is opened for the refresh.
 */
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentProvider, useAgentContext } from '@/features/agent-context';
import {
  USER_UI_PUBLISHED_EVENT,
  UserUiProvider,
  handleUserUiPublishedEvent,
  refreshActiveUserUi,
  resetUserUiVersionCache,
  useUserUi,
  type UserUiManifest,
} from '@/features/user-ui';
import type { AgentDetail } from '@/lib/api';
import { listenToAgentTree } from '@/hooks/agentTreeSubscription';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToAgent: vi.fn(),
    subscribeToBus: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

import * as RealtimeMod from '@/lib/realtime';

const API_BASE = 'http://localhost:3001/api';
const USERCONTENT = 'https://u-test.usercontent.roselabs.test';
const V1_BASE = `${USERCONTENT}/v1/`;
const V2_BASE = `${USERCONTENT}/v2/`;
const REFRESH_WINDOW_MS = 750;

type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];
type BusHandlers = Parameters<typeof RealtimeMod.subscribeToBus>[1];

const MANIFEST: UserUiManifest = {
  version: 1,
  inline: { chart: { entry: 'inline/chart/index.html', summary: 'Chart' } },
};
/** A pre-removal publish: still names a theme and slots, which must be ignored. */
const LEGACY_MANIFEST = {
  ...MANIFEST,
  theme: 'root/theme.json',
  slots: { background: { entry: 'root/slots/background/index.html' } },
} as UserUiManifest;

function makeAgent(agentId: string): AgentDetail {
  return {
    agent_id: agentId,
    goal: 'Change the background of my Rose app to a mountain photo',
    title: 'Mountain background',
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: `workflow-${agentId}`,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 1,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
  };
}

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
}

/** Mutable published state served by GET /api/user-ui/active. */
interface PublishedState {
  versionId: 'v1' | 'v2';
  requests: number;
  /** theme.json fetches (must stay 0: whole-app themes are removed). */
  themeRequests: number;
}

function newState(versionId: PublishedState['versionId']): PublishedState {
  return { versionId, requests: 0, themeRequests: 0 };
}

function servePublishedUi(state: PublishedState) {
  server.use(
    http.get(`${API_BASE}/user-ui/active`, () => {
      state.requests += 1;
      return HttpResponse.json({
        versionId: state.versionId,
        // v2 is a legacy publish that still carries a theme + background slot.
        manifest: state.versionId === 'v1' ? MANIFEST : LEGACY_MANIFEST,
        baseUrl: state.versionId === 'v1' ? V1_BASE : V2_BASE,
      });
    }),
    http.get(`${USERCONTENT}/:version/root/theme.json`, () => {
      state.themeRequests += 1;
      return HttpResponse.json({
        tokens: { '--rose-accent': 'rebeccapurple' },
        background: { image: 'root/assets/matterhorn.jpg', fadeAfterFirstMessage: 0.2 },
      });
    }),
    // `/agents/tree` would otherwise match `/agents/:agentId` below.
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
      HttpResponse.json({
        agent: makeAgent(String(params.agentId)),
        messages: [
          {
            message_id: 'user-goal',
            timestamp: '2026-01-01T00:00:00.000Z',
            text: 'Change the background of my Rose app to a mountain photo',
            role: 'USER',
          },
        ],
        pagination: { has_more: false, oldest_timestamp: null },
      }),
    ),
  );
}

/** The open agent plus the active version the provider applied (stock = none). */
export function OpenAgentProbe() {
  const { agent } = useAgentContext();
  const { active } = useUserUi();
  return (
    <>
      <output data-testid="open-agent">{agent?.agent_id ?? 'none'}</output>
      <output data-testid="active-version" data-base-url={active?.baseUrl ?? ''}>
        {active?.versionId ?? 'stock'}
      </output>
      <svg data-testid="pattern" />
    </>
  );
}

function renderOpenAgent(roseDesktop: boolean) {
  return renderWithProviders(
    <AgentProvider user={{ id: 'test-user' }} isAuthenticated realtimeReady onLoadAgents={vi.fn()}>
      <UserUiProvider userId="test-user">
        <OpenAgentProbe />
      </UserUiProvider>
    </AgentProvider>,
    { roseDesktop },
  );
}

function expectActiveVersion(versionId: string, baseUrl: string) {
  const probe = screen.getByTestId('active-version');
  expect(probe).toHaveTextContent(versionId);
  expect(probe).toHaveAttribute('data-base-url', baseUrl);
}

/** No whole-app setting reached the page: no tokens, no background, no slot frame. */
function expectNoWholeAppSettings(state: PublishedState) {
  expect(state.themeRequests).toBe(0);
  expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe('');
  expect(document.querySelector('[data-testid^="user-ui-background"]')).toBeNull();
  expect(document.querySelector('[data-user-ui-slot]')).toBeNull();
  expect(document.querySelector('iframe')).toBeNull();
}

function captureAgentHandlers(): Map<string, AgentHandlers> {
  const handlers = new Map<string, AgentHandlers>();
  vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (agentId, callbacks) => {
    handlers.set(agentId, callbacks);
    return { state: 'joined', topic: `agent:${agentId}` } as never;
  });
  return handlers;
}

function insertMessage(handlers: AgentHandlers | undefined, id: string) {
  handlers?.onInsert?.({
    agentId: 'agent-a',
    id,
    timestamp: '2026-01-01T00:00:05.000Z',
    text: `code agent progress ${id}`,
    role: 'ASSISTANT',
  });
}

async function openAgentReady(state: PublishedState, handlers: Map<string, AgentHandlers>) {
  await waitFor(() => expect(screen.getByTestId('open-agent')).toHaveTextContent('agent-a'));
  await waitFor(() => expect(handlers.get('agent-a')).toBeDefined());
  await waitFor(() => expect(screen.getByTestId('active-version')).toHaveTextContent('v1'));
  expect(state.requests).toBe(1);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mockSession();
  resetUserUiVersionCache();
  window.history.replaceState({}, '', '/?agent-id=agent-a');
  vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
  vi.mocked(RealtimeMod.subscribeToBus).mockReset();
  vi.mocked(RealtimeMod.unsubscribe).mockReset();
});

afterEach(() => {
  document.documentElement.removeAttribute('style');
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
});

describe('user UI live refresh (Rose Desktop)', () => {
  it('swaps in a version published mid-session when the open agent gets a message, without a reload', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    await openAgentReady(state, handlers);
    const pattern = screen.getByTestId('pattern');

    // The code agent publishes v2...
    state.versionId = 'v2';
    // ...and its progress arrives on the chat's existing agent:<id> channel.
    act(() => {
      for (let index = 0; index < 6; index += 1)
        insertMessage(handlers.get('agent-a'), `m${index}`);
      handlers.get('agent-a')?.onUpdate?.({ status: 'COMPLETED' });
    });

    await waitFor(() => expectActiveVersion('v2', V2_BASE));
    // In place: the app subtree was never remounted.
    expect(screen.getByTestId('pattern')).toBe(pattern);
    // A burst of 7 realtime events → exactly one refetch in that window.
    expect(state.requests).toBe(2);
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(2);
    // The refresh reused the chat's channel: one agent subscription, no bus.
    expect(RealtimeMod.subscribeToAgent).toHaveBeenCalledTimes(1);
    expect(RealtimeMod.subscribeToBus).not.toHaveBeenCalled();
  });

  it('ignores the removed theme/background/slots of a refreshed legacy manifest (no theme.json, no layer)', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    await openAgentReady(state, handlers);

    // v2 still names root/theme.json (with a background) and a background slot.
    state.versionId = 'v2';
    act(() => handlers.get('agent-a')?.onUserUiActiveChanged?.({ versionId: 'v2', agentId: 'c' }));
    await waitFor(() => expectActiveVersion('v2', V2_BASE));
    await sleep(100);
    expectNoWholeAppSettings(state);
  });

  it('refreshes when a sub-agent shown in the open view changes status on its existing bus', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    const busHandlers = new Map<string, BusHandlers>();
    vi.mocked(RealtimeMod.subscribeToBus).mockImplementation(async (busId, callbacks) => {
      busHandlers.set(busId, callbacks);
      return { state: 'joined', topic: `bus:${busId}` } as never;
    });
    renderOpenAgent(true);
    await openAgentReady(state, handlers);
    // The open view's SubAgentTree already holds the tree bus for agent-a.
    const releaseTree = listenToAgentTree('agent-a', () => {});
    await waitFor(() => expect(busHandlers.get('agent-a')).toBeDefined());

    state.versionId = 'v2';
    act(() =>
      busHandlers.get('agent-a')?.onAgentStateChanged?.({
        agentId: 'code-agent-1',
        parentAgentId: 'agent-a',
        goal: 'publish rose_user_ui',
        status: 'COMPLETED',
        progress: 1,
        toolsInUse: [],
        messageCount: 12,
      }),
    );

    await waitFor(() => expectActiveVersion('v2', V2_BASE));
    expect(state.requests).toBe(2);
    // Only the tree's own bus exists — the refresh opened nothing new.
    expect(RealtimeMod.subscribeToBus).toHaveBeenCalledTimes(1);
    releaseTree();
  });

  it('exposes refreshActiveUserUi() and a typed user_ui.published hook point', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    await openAgentReady(state, handlers);

    // An event for the version already on screen is deduped (no request).
    act(() => handleUserUiPublishedEvent({ type: USER_UI_PUBLISHED_EVENT, versionId: 'v1' }));
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(1);

    state.versionId = 'v2';
    act(() => handleUserUiPublishedEvent({ type: USER_UI_PUBLISHED_EVENT, versionId: 'v2' }));
    await waitFor(() => expectActiveVersion('v2', V2_BASE));
    expect(state.requests).toBe(2);

    act(() => {
      refreshActiveUserUi();
      refreshActiveUserUi();
    });
    await waitFor(() => expect(state.requests).toBe(3));
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(3);
  });

  it('cancels a pending refresh on unmount (no request after the view closes)', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    const { unmount } = renderOpenAgent(true);
    await openAgentReady(state, handlers);

    act(() => insertMessage(handlers.get('agent-a'), 'late'));
    unmount();
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(1);
    // A hook-point call with nothing mounted is a no-op.
    refreshActiveUserUi();
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(1);
  });

  it('USER_UI_ACTIVE_CHANGED on the root channel applies the new version with one /active fetch; duplicates fire none', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    await openAgentReady(state, handlers);
    const pattern = screen.getByTestId('pattern');

    // A code agent under agent-a ran `rose-ui publish`: the backend announces the
    // new active version on the root's existing agent:<id> channel.
    state.versionId = 'v2';
    act(() => {
      handlers.get('agent-a')?.onUserUiActiveChanged?.({ versionId: 'v2', agentId: 'code-1' });
      handlers.get('agent-a')?.onUserUiActiveChanged?.({ versionId: 'v2', agentId: 'code-1' });
    });
    await waitFor(() => expectActiveVersion('v2', V2_BASE));
    expect(screen.getByTestId('pattern')).toBe(pattern);
    expect(state.requests).toBe(2);

    // The same version again (e.g. the publishing agent's own channel echo): no fetch.
    act(() => {
      handlers.get('agent-a')?.onUserUiActiveChanged?.({ versionId: 'v2', agentId: 'code-1' });
    });
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(2);
    expect(RealtimeMod.subscribeToAgent).toHaveBeenCalledTimes(1);
    expect(RealtimeMod.subscribeToBus).not.toHaveBeenCalled();
  });

  it('flag off: USER_UI_ACTIVE_CHANGED causes no /active fetch', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(false);
    await openAgentReady(state, handlers);
    state.versionId = 'v2';
    act(() => {
      handlers.get('agent-a')?.onUserUiActiveChanged?.({ versionId: 'v2', agentId: 'code-1' });
    });
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(1);
    expectActiveVersion('v1', V1_BASE);
  });

  it('flag off: realtime messages for the open agent cause no extra /active fetches', async () => {
    const state = newState('v1');
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(false);
    await openAgentReady(state, handlers);

    state.versionId = 'v2';
    act(() => {
      for (let index = 0; index < 4; index += 1)
        insertMessage(handlers.get('agent-a'), `m${index}`);
      handlers.get('agent-a')?.onUpdate?.({ status: 'COMPLETED' });
    });
    await sleep(REFRESH_WINDOW_MS + 400);
    expect(state.requests).toBe(1);
    expectActiveVersion('v1', V1_BASE);
    expectNoWholeAppSettings(state);
  });
});
