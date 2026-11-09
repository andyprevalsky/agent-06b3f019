/**
 * Shared helpers for the Rose left-bar code-agent view blackboxes
 * (rose-code-agent-view.blackbox.tsx and rose-code-agent-view-session.blackbox.tsx):
 * MSW backend, sign-in, the real Terminal on the owner agent and the row/open
 * helpers. `vi.mock` calls are hoisted per test file and stay in each file.
 */
import { vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import type { CodeAgentListItem } from '@/lib/api/tree';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { chipMessage, eventsMessage, LIVE_EVENTS, msg } from './code-agent-steering.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { expandBar, makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

export const API_BASE = 'http://localhost:3001/api';
export const OWNER = 'agent-001';
export const OTHER = 'agent-002';
export const TASK = 'task-1';

export function signInAs(userId: string) {
  const user = { id: userId, is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

export function agentRow(agentId: string, goal: string, minutesAgo: number) {
  const at = new Date(Date.parse('2026-10-20T12:00:00Z') - minutesAgo * 60_000).toISOString();
  return {
    agent_id: agentId,
    goal,
    model: 'rose-1-flash',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 50,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: `wf-${agentId}`,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    context_size: 0,
    message_count: 2,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: at,
    updated_at: at,
    write_lock_enabled: false,
  };
}

export const ROW: CodeAgentListItem = {
  code_agent_id: TASK,
  owner_agent_id: OWNER,
  root_agent_id: OWNER,
  provider: 'codex',
  status: 'ACTIVE',
  title: 'Make the speed button 3-state',
  created_at: '2026-10-20T11:59:30.000Z',
};

export function ownerChat(rows: Message[]): Message[] {
  return [msg({}, { role: 'USER', text: 'Polish the speed button' }), ...rows];
}

export const liveRows = () => [chipMessage(), eventsMessage(LIVE_EVENTS)];

/** Serves the list, the batched code agents and each agent's detail; captures direct turns. */
export function serveBackend({
  ownerMessages = ownerChat(liveRows()),
  turns = () => HttpResponse.json({ status: 'delivered', message_id: 'turn-msg-1' }),
}: {
  ownerMessages?: Message[];
  turns?: () => Response;
} = {}) {
  server.use(
    http.get(`${API_BASE}/agents`, () =>
      HttpResponse.json({
        agents: [agentRow(OWNER, 'Polish Rose UI', 1), agentRow(OTHER, 'Plan Tahoe trip', 2)],
      }),
    ),
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/code-agents`, () => HttpResponse.json({ code_agents: [ROW] })),
    http.get(`${API_BASE}/agents/:agentId`, ({ params }) => {
      const id = String(params.agentId);
      const own = id === OWNER;
      return HttpResponse.json({
        agent: {
          ...agentRow(id, own ? 'Polish Rose UI' : 'Plan Tahoe trip', 1),
          parent_agent_id: null,
          parent_goal: null,
          verifier: null,
          tools: [],
        },
        messages: own ? ownerMessages : [msg({}, { role: 'USER', text: 'Plan a Tahoe weekend' })],
        pagination: { has_more: false, oldest_timestamp: null },
      });
    }),
    http.post(`${API_BASE}/claude-code-session/:taskId/turns`, turns),
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({
        effective_settings: { model: 'gpt-test', effort: 'medium', speed: 'standard' },
        models: [
          {
            model: 'gpt-test',
            label: 'Test Codex',
            efforts: ['medium', 'high'],
            speeds: ['standard', 'fast'],
          },
        ],
      }),
    ),
    // The chip's closed-session fallback (owner chat) reads the Codex session once.
    http.get(`${API_BASE}/codex-code-session/:taskId`, () =>
      HttpResponse.json({ status: 'RUNNING', output: '' }),
    ),
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
}

export function requests(method: string, path: string) {
  return capturedRequests.filter((r) => r.method === method && new URL(r.url).pathname === path);
}

export const urlParams = () => new URL(window.location.href).searchParams;

export const row = () => screen.getByTestId(`rose-code-agent-row-${TASK}`);
export const view = () => screen.queryByTestId('code-agent-view');

/** The real Terminal on the owner agent (its chat holds the session's chip). */
export async function renderOnOwner(route = `/?agent-id=${OWNER}`) {
  window.history.replaceState({}, '', route);
  const user = userEvent.setup({ delay: null });
  renderWithProviders(<Terminal />);
  await screen.findByTestId('rose-sidebar');
  expandBar();
  const ownerRow = await screen.findByTestId(`rose-agent-row-${OWNER}`);
  const branch = ownerRow.closest('[data-agent-depth]') as HTMLElement;
  const disclosure = await within(branch).findByRole('button', { name: /^Expand|^Collapse/ });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  await screen.findByTestId(`rose-code-agent-row-${TASK}`);
  return user;
}

/**
 * The owner chat's code-agent row: it folds into a "Worked for …"/"Working" work
 * group of the root transcript; expand the group (its first button) and return it.
 */
export async function ownerCodeAgentRow(): Promise<HTMLElement> {
  const groups = await screen.findAllByTestId('trajectory-work-group');
  for (const group of groups) {
    const toggle = within(group).getAllByRole('button')[0];
    if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
  }
  return screen.findByTestId('code-agent-chip');
}

export async function openFromRow(user: ReturnType<typeof userEvent.setup>) {
  await ownerCodeAgentRow();
  expandBar();
  fireEvent.click(row());
  return screen.findByTestId('code-agent-view');
}

/** Per-test setup shared by the view files: signed-in desktop user, projects and backend. */
export function resetRoseViewState() {
  localStorage.clear();
  resetCodeAgentLocalState();
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
  mockProjectsApi([makeProject()]);
  serveBackend();
}

/** Per-test teardown shared by the view files. */
export function restoreRoseViewState() {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
  document.documentElement.classList.remove('dark');
}
