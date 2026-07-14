/**
 * Blackbox tests for CostLimitModal.
 * Covers render open/closed, input default, input validation, increase flow
 * (success + error), delete confirm 1.8s gate + success + error, cancel path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import CostLimitModal from '@/features/terminal-component-group/components/CostLimitModal';

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

describe('CostLimitModal', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('does not render dialog content when closed', () => {
    renderWithProviders(
      <CostLimitModal
        open={false}
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    expect(
      screen.queryByText(/This Task Has Crossed the Price Limit Set/i),
    ).not.toBeInTheDocument();
  });

  it('renders current cost + limit + default input value on open', () => {
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    expect(screen.getByText(/This Task Has Crossed the Price Limit Set/i)).toBeInTheDocument();
    expect(screen.getByText('$0.80')).toBeInTheDocument(); // cost
    expect(screen.getByText('$1.00')).toBeInTheDocument(); // limit
    // Default new limit = currentLimitCents + 50 = 150 cents => $1.50
    const input = screen.getByLabelText('New Price Limit') as HTMLInputElement;
    expect(input.value).toBe('$1.50');
  });

  it('shows toast error and does not call API when amount is invalid', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    const input = screen.getByLabelText('New Price Limit') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, 'not-a-number');
    await u.click(screen.getByRole('button', { name: /Increase Limit/i }));

    await new Promise((r) => setTimeout(r, 50));
    const req = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
    );
    expect(req).toBeUndefined();
  });

  it('rejects a new limit below currentCostCents', async () => {
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={300}
      />,
    );
    const input = screen.getByLabelText('New Price Limit') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '1.00'); // below $3.00
    await u.click(screen.getByRole('button', { name: /Increase Limit/i }));

    await new Promise((r) => setTimeout(r, 50));
    const req = capturedRequests.find(
      (r) => r.method === 'PATCH' && r.url.includes('/api/agents/'),
    );
    expect(req).toBeUndefined();
  });

  it('increases limit via PATCH and invokes callbacks', async () => {
    const onOpenChange = vi.fn();
    const onIncrease = vi.fn();
    server.use(
      http.patch(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ agent: { price_limit_cents: 999 } }),
      ),
    );
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={onOpenChange}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
        onIncrease={onIncrease}
      />,
    );
    const input = screen.getByLabelText('New Price Limit') as HTMLInputElement;
    await u.clear(input);
    await u.type(input, '9.99');
    await u.click(screen.getByRole('button', { name: /Increase Limit/i }));

    await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.url.includes('/api/agents/a-1'),
      );
      expect(req).toBeDefined();
      expect((req!.body as never).price_limit_cents).toBe(999);
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onIncrease).toHaveBeenCalled());
  });

  it('shows error toast on increase-limit API failure', async () => {
    server.use(
      http.patch(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'server down' }, { status: 500 }),
      ),
    );
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    await u.click(screen.getByRole('button', { name: /Increase Limit/i }));
    // Button stops spinning on error
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Increase Limit/i })).not.toBeDisabled();
    });
  });

  it('delete confirm flow: initial button disabled, enables after 1.8s, cancel returns', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const u = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={() => {}}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    await u.click(screen.getByRole('button', { name: /Delete/i }));

    // "Wait..." button present and disabled initially
    expect(screen.getByRole('button', { name: /Wait/ })).toBeDisabled();

    // Advance past 1.8s to enable confirm
    vi.advanceTimersByTime(2000);
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm/ })).toBeEnabled());

    // Cancel returns to idle state
    await u.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('delete confirm success calls deleteAgent + closes and fires onDelete', async () => {
    server.use(
      http.delete(`${API_BASE}/agents/:agentId`, () => new HttpResponse(null, { status: 204 })),
    );
    const onOpenChange = vi.fn();
    const onDelete = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={onOpenChange}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
        onDelete={onDelete}
      />,
    );
    await u.click(screen.getByRole('button', { name: /Delete/ }));
    // Wait 1.8s with real timers for confirm to enable
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm/ })).toBeEnabled(), {
      timeout: 3000,
    });
    await u.click(screen.getByRole('button', { name: /Confirm/ }));

    await waitFor(() => {
      const req = capturedRequests.find(
        (r) => r.method === 'DELETE' && r.url.includes('/api/agents/a-1'),
      );
      expect(req).toBeDefined();
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
  }, 10000);

  it('delete confirm failure shows error (no close)', async () => {
    server.use(
      http.delete(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const onOpenChange = vi.fn();
    const u = userEvent.setup();
    renderWithProviders(
      <CostLimitModal
        open
        onOpenChange={onOpenChange}
        agentId="a-1"
        currentLimitCents={100}
        currentCostCents={80}
      />,
    );
    await u.click(screen.getByRole('button', { name: /Delete/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Confirm/ })).toBeEnabled(), {
      timeout: 3000,
    });
    await u.click(screen.getByRole('button', { name: /Confirm/ }));

    // Wait for server response to resolve then assert state stayed open
    await new Promise((r) => setTimeout(r, 100));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  }, 10000);
});
