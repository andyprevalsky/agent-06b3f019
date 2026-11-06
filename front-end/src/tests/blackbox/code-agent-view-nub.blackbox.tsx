/**
 * Blackbox (final-run5 replay, code agent 7e45fb38): the code agent's query box
 * shows its working settings through the EXISTING nub, model chip and speed toggle.
 *
 *   nub    never an empty strip: the context meter (percent of the model's window,
 *          or the tokens while the window is not known yet) + the existing Agent
 *          settings gear fed by the code agent's own data (Context Usage bar,
 *          Tokens In/Out, Messages, sandbox cost)
 *   chip   "<model> · <effort>" from the CLI's init record, no "claude/" prefix
 *   speed  the session's speed (standard here)
 * The fixture is the run's code-agent rows (code-agent-view-final-run5.fixture.json).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { resetCodeAgentLocalState } from '@/features/terminal-component-group/hooks/codeAgentLocalState';
import type { Message } from '@/lib/api';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import run5 from './code-agent-view-final-run5.fixture.json';
import { server } from './msw/server';
import { makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import { renderWithProviders } from './test-wrapper';

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

const API_BASE = 'http://localhost:3001/api';
const OWNER = run5.agent.agent_id;
const TASK = '7e45fb38-1729-4677-aa8e-fd9c7dfb37da';
const MESSAGES = run5.messages as unknown as Message[];

function signInAs(userId: string) {
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

function ownerDetail(messages: Message[]) {
  return {
    agent: {
      ...run5.agent,
      model: 'rose-labs/rose-1-ultra',
      source: 'MAC_APP',
      reasoning_effort: 'medium',
      progress: 1,
      status_message: null,
      temporal_workflow_id: `wf-${OWNER}`,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      context_size: 0,
      message_count: messages.length,
      price_limit_cents: 1000,
      tree_cost_cents: 0,
      write_lock_enabled: true,
      parent_agent_id: null,
      parent_goal: null,
      verifier: null,
      tools: [],
    },
    messages,
    pagination: { has_more: false, oldest_timestamp: null },
  };
}

type Rec = Record<string, unknown>;

/** The fixture with every code-transcript record passed through `edit` (null drops it). */
function withRecords(edit: (record: Rec) => Rec | null): Message[] {
  return MESSAGES.map((message) => {
    const events = message.metadata?.code_agent_events;
    if (!Array.isArray(events)) return message;
    const next = events.map((record) => edit({ ...(record as Rec) })).filter((r) => r !== null);
    return { ...message, metadata: { ...message.metadata, code_agent_events: next } } as Message;
  });
}

async function openView(messages: Message[]) {
  const detail = ownerDetail(messages);
  server.use(
    http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: [detail.agent] })),
    http.get(`${API_BASE}/agents/tree`, () => HttpResponse.json({ agents: [] })),
    http.get(`${API_BASE}/agents/code-agents`, () => HttpResponse.json({ code_agents: [] })),
    http.get(`${API_BASE}/agents/:agentId`, () => HttpResponse.json(detail)),
    http.get(`${API_BASE}/claude-code-session/:taskId/capabilities`, () =>
      HttpResponse.json({ error: 'not live' }, { status: 502 }),
    ),
    http.get(`${API_BASE}/claude-code-session/:taskId`, () =>
      HttpResponse.json({ status: 'CLOSED', output: '' }),
    ),
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Andy' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
  window.history.replaceState({}, '', `/?agent-id=${OWNER}&code-agent=${TASK}`);
  renderWithProviders(<Terminal />);
  await screen.findByTestId('code-agent-view');
  return screen.findByTestId('query-input-host');
}

beforeEach(() => {
  localStorage.clear();
  resetCodeAgentLocalState();
  signInAs(ROSE_DESKTOP_USER_IDS[0]);
  mockProjectsApi([makeProject()]);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  localStorage.clear();
});

describe('code-agent query box working settings (final-run5)', () => {
  it('the nub carries the context meter and the Agent settings gear fed by the code agent', async () => {
    const box = await openView(MESSAGES);
    // 87,169 of the model's 1,000,000-token window.
    await waitFor(() => expect(within(box).getByTestId('nub-context')).toHaveTextContent('9%'));
    expect(within(box).getByTestId('nub-context')).toHaveAttribute(
      'aria-label',
      'Context window used: 9%',
    );
    fireEvent.click(within(box).getByRole('button', { name: 'Agent settings' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Context Usage')).toBeInTheDocument();
    expect(within(dialog).getByText('8.7%')).toBeInTheDocument();
    expect(within(dialog).getByText(/87,169 \/ 1,000,000 context used/)).toBeInTheDocument();
    // Real usage, not the zeros of an agent without data.
    expect(within(dialog).getByText('Tokens In/Out').nextElementSibling).not.toHaveTextContent(
      /^0 \/ 0$/,
    );
  });

  it('the model chip names the model and its effort; the speed toggle shows the session speed', async () => {
    const box = await openView(MESSAGES);
    const chip = await within(box).findByTestId('query-model-selector');
    expect(chip).toHaveTextContent('claude-opus-5-5 · xhigh');
    expect(chip).not.toHaveTextContent('claude/');
    expect(within(box).getByTestId('speed-toggle')).toHaveAttribute('data-state', 'normal');
  });

  it('while the model window is unknown the meter shows the tokens, never an empty nub', async () => {
    const box = await openView(
      withRecords((record) => {
        delete record.context_window;
        return record;
      }),
    );
    await waitFor(() => expect(within(box).getByTestId('nub-context')).toHaveTextContent('87k'));
    expect(within(box).getByTestId('nub-context')).toHaveAttribute(
      'aria-label',
      'Context used: 87,169 tokens',
    );
    expect(within(box).getByRole('button', { name: 'Agent settings' })).toBeInTheDocument();
  });

  it('with no usage records the nub still holds the Agent settings gear', async () => {
    const box = await openView(
      withRecords((record) => (record.type === 'metrics' ? null : record)),
    );
    expect(within(box).queryByTestId('nub-context')).toBeNull();
    expect(await within(box).findByRole('button', { name: 'Agent settings' })).toBeInTheDocument();
    expect(within(box).getByTestId('query-toolbar-nub')).toBeInTheDocument();
  });
});
