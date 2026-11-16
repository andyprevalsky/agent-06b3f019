/**
 * Blackbox tests for Skip in the attention request views. Desktop (the bell
 * modal) and mobile (the drawer's Notifications tab) share one inbox; Skip must
 * be offered for every request kind — gate, auth assistance and generic — and
 * send the current notification to the back of the queue so the next one shows.
 *
 * MSW serves a stateful queue that mirrors the backend contract: the list is
 * ordered by updatedAt and POST /:id/skip bumps updatedAt, i.e. moves the
 * request to the end without answering it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import AttentionInbox from '@/features/terminal-component-group/components/AttentionInbox';
import MobileAgentDrawer from '@/features/terminal-component-group/components/MobileAgentDrawer';

const API_BASE = '*/api';

function baseRequest(id: string, question: string, metadata: Record<string, unknown> | null) {
  return {
    id,
    agent_id: `agent-${id}`,
    workflow_id: `wf-${id}`,
    question,
    image_url: null,
    metadata,
    user_response: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    answered: false,
  };
}

function initialQueue() {
  return [
    baseRequest('gate', 'gate question', {
      gate: {
        gateKey: 'connect-gmail',
        type: 'oauth',
        presentation: { title: 'Connect Gmail', reason: 'Needed to read mail', cta: 'Connect' },
        action: { kind: 'link', url: 'https://example.com/oauth' },
      },
    }),
    baseRequest('auth', 'Sign in to amazon.com', {
      attentionKind: 'auth_assistance',
      authAssistance: {
        requestId: 'auth',
        authRealm: 'amazon.com',
        mode: 'live_view',
        liveViewUrl: 'https://debug.steel.dev/session/auth?interactive=true',
      },
    }),
    baseRequest('generic', 'Approve the purchase?', null),
  ];
}

let queue: ReturnType<typeof initialQueue>;
let skipped: string[];

function installQueueHandlers() {
  queue = initialQueue();
  skipped = [];
  server.use(
    http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({ requests: queue })),
    http.post(`${API_BASE}/attention-requests/:id/skip`, ({ params }) => {
      const id = params.id as string;
      skipped.push(id);
      const idx = queue.findIndex((r) => r.id === id);
      const [moved] = queue.splice(idx, 1);
      queue.push({ ...moved, updated_at: new Date().toISOString() });
      return HttpResponse.json({ success: true, request_id: id });
    }),
  );
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
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

/** Skip through every kind and wrap back to the first: proves back-of-queue. */
async function skipThroughQueue(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Connect Gmail');
  expect(screen.getByText('2 more requests waiting')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await screen.findByText('Authentication');
  expect(screen.queryByText('Connect Gmail')).toBeNull();
  expect(screen.getByText('2 more requests waiting')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await screen.findByText('Approve the purchase?');
  expect(screen.queryByText('Authentication')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Skip' }));
  await screen.findByText('Connect Gmail');

  expect(skipped).toEqual(['gate', 'auth', 'generic']);
  expect(queue.map((r) => r.id)).toEqual(['gate', 'auth', 'generic']);
  expect(queue.every((r) => !r.answered)).toBe(true);
}

describe('attention request Skip moves the current notification to the back of the queue', () => {
  beforeEach(() => {
    mockSession();
    installQueueHandlers();
  });
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('desktop bell modal: Skip on gate, auth and generic requests cycles the queue', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AttentionInbox />);

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Attention requests' }));

    await skipThroughQueue(user);
  });

  it('mobile drawer Notifications tab: Skip on gate, auth and generic requests cycles the queue', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MobileAgentDrawer
        agents={[]}
        isLoadingAgents={false}
        hasLoadedAgents
        selectedAgentId={null}
        onSelectAgent={vi.fn()}
        onCreateAgent={vi.fn()}
        onRefreshAgents={vi.fn().mockResolvedValue(undefined)}
        realtimeReady={false}
        isSignedIn
        onLoginClick={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByRole('button', { name: /^Notifications/ }));

    await skipThroughQueue(user);
  });
});
