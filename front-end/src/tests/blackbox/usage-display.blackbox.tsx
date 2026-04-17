/**
 * Blackbox tests for UsageDisplay.
 *
 * The component calls GET /api/credits/usage on mount and every 30s. We cover:
 *   - loading state (no session → loading returns before fetch)
 *   - READY state with healthy credits (green)
 *   - low credits warning
 *   - depleted credits (auto-opens subscription modal, shows red alert)
 *   - API failure path (logs, stays in "loading"/null state)
 *   - upgrade button opens subscription modal
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

import UsageDisplay from '@/components/UsageDisplay';

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

// Mock the SubscriptionModal so we don't have to render its stripe-heavy guts.
vi.mock('@/components/SubscriptionModal', () => ({
  default: ({ open }: { open: boolean }) => (
    <div data-testid="subscription-modal" data-open={open ? 'true' : 'false'} />
  ),
}));

describe('UsageDisplay', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  it('shows loading state when no session is present', async () => {
    localStorage.clear();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderWithProviders(<UsageDisplay />);
    // Immediate render: the Loading... text
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await waitFor(() => {
      // No session → setLoading(false) still runs but usage remains null,
      // so we stay in the "loading or no usage" branch which shows Loading...
      expect(screen.getByText('Loading...')).toBeInTheDocument();
    });
    logSpy.mockRestore();
  });

  it('renders healthy state with green credit card and no alert', async () => {
    server.use(
      http.get(`${API_BASE}/credits/usage`, () =>
        HttpResponse.json({
          total: 100,
          used: 10,
          remaining: 90,
          tier: 20,
          upgradeOptions: [{ tier: 30, name: 'Pro', url: 'u' }],
        }),
      ),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(screen.getByText('90 credits')).toBeInTheDocument();
    });
    // Healthy: no alert-circle badge text
    expect(screen.queryByText(/low credits/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/out of credits/i)).not.toBeInTheDocument();
    // Tier info
    expect(screen.getByText(/current plan: \$20\/month/i)).toBeInTheDocument();
    // Modal starts closed
    const modal = screen.getByTestId('subscription-modal');
    expect(modal.getAttribute('data-open')).toBe('false');
  });

  it('renders low-credits warning when 0 < remaining < 1', async () => {
    server.use(
      http.get(`${API_BASE}/credits/usage`, () =>
        HttpResponse.json({
          total: 100,
          used: 99.5,
          remaining: 0.5,
          tier: null,
          upgradeOptions: [],
        }),
      ),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(screen.getByText(/low credits/i)).toBeInTheDocument();
    });
  });

  it('renders depleted state and auto-opens the subscription modal', async () => {
    server.use(
      http.get(`${API_BASE}/credits/usage`, () =>
        HttpResponse.json({
          total: 100,
          used: 100,
          remaining: 0,
          tier: null,
          upgradeOptions: [],
        }),
      ),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(screen.getByText(/out of credits/i)).toBeInTheDocument();
    });
    // Auto-opens modal
    const modal = screen.getByTestId('subscription-modal');
    expect(modal.getAttribute('data-open')).toBe('true');
  });

  it('logs an error when the API returns a non-OK status', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get(`${API_BASE}/credits/usage`, () => new HttpResponse(null, { status: 500 })),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith('Failed to fetch usage:', 500);
    });
    errSpy.mockRestore();
  });

  it('logs an error when the fetch throws a network error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.use(
      http.get(`${API_BASE}/credits/usage`, () => {
        throw new Error('boom');
      }),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    errSpy.mockRestore();
  });

  it('clicking Upgrade button opens the subscription modal', async () => {
    server.use(
      http.get(`${API_BASE}/credits/usage`, () =>
        HttpResponse.json({
          total: 100,
          used: 10,
          remaining: 90,
          tier: 20,
          upgradeOptions: [],
        }),
      ),
    );
    renderWithProviders(<UsageDisplay />);
    await waitFor(() => {
      expect(screen.getByText('90 credits')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /upgrade/i }));
    await waitFor(() => {
      expect(screen.getByTestId('subscription-modal').getAttribute('data-open')).toBe('true');
    });
  });
});
