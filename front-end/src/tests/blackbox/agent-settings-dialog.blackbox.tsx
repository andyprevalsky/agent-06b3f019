/**
 * Blackbox tests for AgentSettingsDialog.
 * Covers open/close, no-agent state, metrics rendering, price-limit edit/save/cancel,
 * response-schema rendering, and the 1.8s delete-confirmation timer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import AgentSettingsDialog from '@/features/terminal-component-group/components/AgentSettingsDialog';
import type { AgentDetail } from '@/lib/api';

const API_BASE = 'http://localhost:3001/api';

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

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'agent-xyz',
    goal: 'Test',
    model: 'rose-1-lite',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: 'wf-1',
    token_count: 1000,
    tokens_in: 500,
    tokens_out: 300,
    tool_tokens_in: 100,
    tool_tokens_out: 50,
    tool_cost_cents: 10,
    context_size: 20_000,
    message_count: 7,
    price_limit_cents: 500,
    tree_cost_cents: 25,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    response_schema: null,
    ...overrides,
  } as AgentDetail;
}

describe('AgentSettingsDialog', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
    vi.useRealTimers();
  });
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('renders the settings trigger button', () => {
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    const trigger = document.querySelector('button');
    expect(trigger).not.toBeNull();
    // lucide Settings icon
    expect(document.querySelector('svg.lucide-settings')).not.toBeNull();
  });

  it('shows the empty state when agent is null', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={null} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText(/create an agent to view agent settings/)).toBeInTheDocument();
    });
  });

  it('renders metrics (messages / tokens / cost) when opened', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Metrics')).toBeInTheDocument();
    });
    expect(screen.getByText('Messages')).toBeInTheDocument();
    // message_count displayed
    expect(screen.getByText('7')).toBeInTheDocument();
    // tokens combined: 500+100 / 300+50 = 600 / 350
    expect(screen.getByText(/600 \/ 350/)).toBeInTheDocument();
    // cost: 25c → $0.25 appears for both main "Cost" metric and tree-cost subrow
    expect(screen.getAllByText('$0.25').length).toBeGreaterThan(0);
  });

  it('renders response schema fields when provided', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog
        agent={makeAgent({
          response_schema: {
            fields: [
              { name: 'title', type: 'str', required: true, description: 'Article title' },
              { name: 'count', type: 'int', required: false, description: 'Count thing' },
            ],
          },
        })}
      />,
    );
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Output Schema')).toBeInTheDocument();
    });
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('string')).toBeInTheDocument();
    expect(screen.getByText('required')).toBeInTheDocument();
    expect(screen.getByText('count')).toBeInTheDocument();
    expect(screen.getByText('integer')).toBeInTheDocument();
  });

  it('shows "Schema generating..." when no response schema', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent({ response_schema: null })} />);
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Schema generating...')).toBeInTheDocument();
    });
  });

  it('enters price-limit edit mode and updates input value', async () => {
    const u = userEvent.setup();
    renderWithProviders(<AgentSettingsDialog agent={makeAgent({ price_limit_cents: 250 })} />);
    await u.click(document.querySelector('button')!);

    // Price limit button shows "$2.50" — match first (sub-row with same value exists)
    const priceBtn = (await screen.findAllByText('$2.50'))[0];
    await u.click(priceBtn);

    // Now an input + Save button appear
    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    expect(input.value).toBe('2.50');

    await u.clear(input);
    await u.type(input, '9.99');
    expect(input.value).toBe('9.99');

    // Save button present
    expect(screen.getByRole('button', { name: /Save/ })).toBeInTheDocument();
  });

  it('saves a new price limit via PATCH /api/agents/:id', async () => {
    const u = userEvent.setup();
    server.use(
      http.patch(`${API_BASE}/agents/:agentId`, () => {
        return HttpResponse.json({ agent: { price_limit_cents: 999 } });
      }),
    );
    const onUpdate = vi.fn();
    renderWithProviders(
      <AgentSettingsDialog agent={makeAgent({ price_limit_cents: 250 })} onUpdate={onUpdate} />,
    );
    await u.click(document.querySelector('button')!);
    await u.click((await screen.findAllByText('$2.50'))[0]);

    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '9.99');
    await u.keyboard('{Enter}');

    await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
      );
      expect(req).toBeDefined();
      expect((req!.body as any).price_limit_cents).toBe(999);
    });
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('rejects price limit lower than tree_cost_cents', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog
        agent={makeAgent({ price_limit_cents: 500, tree_cost_cents: 300 })}
      />,
    );
    await u.click(document.querySelector('button')!);
    await u.click((await screen.findAllByText('$5.00'))[0]);

    const input = screen.getByPlaceholderText('1.00') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '0.50'); // below 300c = $3.00
    await u.keyboard('{Enter}');

    // No PATCH request fires
    await new Promise((r) => setTimeout(r, 50));
    const req = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
    );
    expect(req).toBeUndefined();
  });

  it('shows delete confirmation and enables confirm after 1.8s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);

    const deleteBtn = await screen.findByRole('button', { name: /Delete Agent/ });
    await u.click(deleteBtn);

    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
    // Initially the confirm button shows "Wait..."
    expect(screen.getByRole('button', { name: /Wait/ })).toBeDisabled();

    // Advance past 1.8s
    vi.advanceTimersByTime(2000);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Delete$/ })).toBeEnabled();
    });
    vi.useRealTimers();
  });

  it('cancel button returns to idle state without calling delete', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<AgentSettingsDialog agent={makeAgent()} />);
    await u.click(document.querySelector('button')!);

    const deleteBtn = await screen.findByRole('button', { name: /Delete Agent/ });
    await u.click(deleteBtn);
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /Cancel/ });
    await u.click(cancelBtn);

    expect(screen.queryByText('Are you sure?')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('hides price-limit section for sub-agents (parent_agent_id set)', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <AgentSettingsDialog agent={makeAgent({ parent_agent_id: 'parent-001' })} />,
    );
    await u.click(document.querySelector('button')!);
    await waitFor(() => {
      expect(screen.getByText('Metrics')).toBeInTheDocument();
    });
    expect(screen.queryByText('Price Limit')).not.toBeInTheDocument();
  });
});
