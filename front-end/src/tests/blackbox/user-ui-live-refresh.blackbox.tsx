/**
 * Live refresh of the per-user UI (features/user-ui) while a session is open.
 *
 * STATE MACHINE (under test):
 *   [ACTIVE v1] --open agent / its sub-agent: new message or status change-->
 *   [REFRESH PENDING] (one GET /api/user-ui/active per 750ms window, deduped)
 *   [REFRESH PENDING] --newer versionId--> [ACTIVE v2] (theme + background
 *   swap in place, no page reload)
 *   [REFRESH PENDING] --unmount--> cancelled (no request)
 *   `user_ui.published` event / refreshActiveUserUi() --> [REFRESH PENDING]
 *
 * Regression for the recorded run where a code agent published theme.json
 * with a background mid-session and nothing changed until a reload
 * (.context/rose-real-recordings/run3/logs/flow2-evidence.txt).
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
  UserUiAppBackdrop,
  UserUiBackgroundLayer,
  UserUiProvider,
  handleUserUiPublishedEvent,
  refreshActiveUserUi,
  resetUserUiVersionCache,
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

const MANIFEST: UserUiManifest = { version: 1, theme: 'root/theme.json' };

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
}

function servePublishedUi(state: PublishedState) {
  server.use(
    http.get(`${API_BASE}/user-ui/active`, () => {
      state.requests += 1;
      return HttpResponse.json({
        versionId: state.versionId,
        manifest: MANIFEST,
        baseUrl: state.versionId === 'v1' ? V1_BASE : V2_BASE,
      });
    }),
    // v1: no background (the recorded "bg before []"); v2: the mountain photo.
    http.get(`${V1_BASE}root/theme.json`, () =>
      HttpResponse.json({ tokens: { '--rose-accent': 'tomato' } }),
    ),
    http.get(`${V2_BASE}root/theme.json`, () =>
      HttpResponse.json({
        tokens: { '--rose-accent': 'rebeccapurple' },
        background: { image: 'root/assets/matterhorn.jpg', fadeAfterFirstMessage: 0.2 },
      }),
    ),
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

/** Mirrors TerminalBackdrop: background behind, app backdrop keyed to USER messages. */
export function OpenAgentBackdrop() {
  const { messages, agent } = useAgentContext();
  const hasUserMessage = messages.some((message) => message.role === 'USER');
  return (
    <>
      <output data-testid="open-agent">{agent?.agent_id ?? 'none'}</output>
      <UserUiBackgroundLayer />
      <UserUiAppBackdrop hasUserMessage={hasUserMessage} appBackgroundClassName="bg-background">
        <svg data-testid="pattern" />
      </UserUiAppBackdrop>
    </>
  );
}

function renderOpenAgent(roseDesktop: boolean) {
  return renderWithProviders(
    <AgentProvider user={{ id: 'test-user' }} isAuthenticated realtimeReady onLoadAgents={vi.fn()}>
      <UserUiProvider userId="test-user">
        <OpenAgentBackdrop />
      </UserUiProvider>
    </AgentProvider>,
    { roseDesktop },
  );
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
  await waitFor(() =>
    expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe('tomato'),
  );
  expect(state.requests).toBe(1);
  expect(screen.queryByTestId('user-ui-background-image')).toBeNull();
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
    const state: PublishedState = { versionId: 'v1', requests: 0 };
    servePublishedUi(state);
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    await openAgentReady(state, handlers);
    const pattern = screen.getByTestId('pattern');

    // The code agent publishes v2 (theme.json with a background)...
    state.versionId = 'v2';
    // ...and its progress arrives on the chat's existing agent:<id> channel.
    act(() => {
      for (let index = 0; index < 6; index += 1)
        insertMessage(handlers.get('agent-a'), `m${index}`);
      handlers.get('agent-a')?.onUpdate?.({ status: 'COMPLETED' });
    });

    const image = await screen.findByTestId('user-ui-background-image');
    expect(image).toHaveAttribute('src', `${V2_BASE}root/assets/matterhorn.jpg`);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe(
        'rebeccapurple',
      ),
    );
    // In place: the app subtree was never remounted and the agent already has
    // a USER message, so the backdrop fades over the new background.
    expect(screen.getByTestId('pattern')).toBe(pattern);
    expect(screen.getByTestId('app-background-layer')).toHaveAttribute(
      'data-backdrop-state',
      'faded',
    );
    // A burst of 7 realtime events → exactly one refetch in that window.
    expect(state.requests).toBe(2);
    await sleep(REFRESH_WINDOW_MS + 250);
    expect(state.requests).toBe(2);
    // The refresh reused the chat's channel: one agent subscription, no bus.
    expect(RealtimeMod.subscribeToAgent).toHaveBeenCalledTimes(1);
    expect(RealtimeMod.subscribeToBus).not.toHaveBeenCalled();
  });

  it('keeps the previous background on screen until the new theme has loaded', async () => {
    const state: PublishedState = { versionId: 'v2', requests: 0 };
    let releaseV3Theme!: () => void;
    const v3ThemeGate = new Promise<void>((resolve) => {
      releaseV3Theme = resolve;
    });
    const V3_BASE = `${USERCONTENT}/v3/`;
    let serveV3 = false;
    server.use(
      http.get(`${API_BASE}/user-ui/active`, () => {
        state.requests += 1;
        return HttpResponse.json(
          serveV3
            ? { versionId: 'v3', manifest: MANIFEST, baseUrl: V3_BASE }
            : { versionId: 'v2', manifest: MANIFEST, baseUrl: V2_BASE },
        );
      }),
      http.get(`${V2_BASE}root/theme.json`, () =>
        HttpResponse.json({ background: { image: 'root/assets/matterhorn.jpg' } }),
      ),
      http.get(`${V3_BASE}root/theme.json`, async () => {
        await v3ThemeGate;
        return HttpResponse.json({ background: { image: 'root/assets/eiger.jpg' } });
      }),
    );
    servePublishedUiAgentOnly();
    const handlers = captureAgentHandlers();
    renderOpenAgent(true);
    const image = await screen.findByTestId('user-ui-background-image');
    expect(image).toHaveAttribute('src', `${V2_BASE}root/assets/matterhorn.jpg`);
    await waitFor(() => expect(handlers.get('agent-a')).toBeDefined());

    serveV3 = true;
    act(() => insertMessage(handlers.get('agent-a'), 'publish-v3'));
    await waitFor(() => expect(state.requests).toBe(2));
    await sleep(50);
    // While v3's theme.json is in flight the v2 image stays (no flash to stock).
    expect(screen.getByTestId('user-ui-background-image')).toBe(image);
    expect(image).toHaveAttribute('src', `${V2_BASE}root/assets/matterhorn.jpg`);

    releaseV3Theme();
    await waitFor(() =>
      expect(screen.getByTestId('user-ui-background-image')).toHaveAttribute(
        'src',
        `${V3_BASE}root/assets/eiger.jpg`,
      ),
    );
    // Swapped in place: same <img> element, new src.
    expect(screen.getByTestId('user-ui-background-image')).toBe(image);
  });

  it('refreshes when a sub-agent shown in the open view changes status on its existing bus', async () => {
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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

    const image = await screen.findByTestId('user-ui-background-image');
    expect(image).toHaveAttribute('src', `${V2_BASE}root/assets/matterhorn.jpg`);
    expect(state.requests).toBe(2);
    // Only the tree's own bus exists — the refresh opened nothing new.
    expect(RealtimeMod.subscribeToBus).toHaveBeenCalledTimes(1);
    releaseTree();
  });

  it('exposes refreshActiveUserUi() and a typed user_ui.published hook point', async () => {
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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
    expect(await screen.findByTestId('user-ui-background-image')).toHaveAttribute(
      'src',
      `${V2_BASE}root/assets/matterhorn.jpg`,
    );
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
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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

  it('USER_UI_ACTIVE_CHANGED on the root channel swaps the theme with one /active fetch; duplicates fire none', async () => {
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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
    expect(await screen.findByTestId('user-ui-background-image')).toHaveAttribute(
      'src',
      `${V2_BASE}root/assets/matterhorn.jpg`,
    );
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--rose-accent')).toBe(
        'rebeccapurple',
      ),
    );
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
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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
  });

  it('flag off: realtime messages for the open agent cause no extra /active fetches', async () => {
    const state: PublishedState = { versionId: 'v1', requests: 0 };
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
    expect(screen.queryByTestId('user-ui-background-image')).toBeNull();
  });
});

/** Agent detail only (the test owns its /active + theme handlers). */
function servePublishedUiAgentOnly() {
  server.use(
    // `/agents/tree` would otherwise match `/agents/:agentId` below.
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
      HttpResponse.json({
        agent: makeAgent(String(params.agentId)),
        messages: [
          {
            message_id: 'user-goal',
            timestamp: '2026-01-01T00:00:00.000Z',
            text: 'Change the background',
            role: 'USER',
          },
        ],
        pagination: { has_more: false, oldest_timestamp: null },
      }),
    ),
  );
}
