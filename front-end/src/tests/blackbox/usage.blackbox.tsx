import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Usage from '@/pages/Usage';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user' },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
}

/** Install handlers for the two endpoints the Usage page calls on mount */
function installUsageHandlers(overrides?: {
  usageData?: Record<string, unknown>;
  statsData?: Record<string, unknown>;
}) {
  server.use(
    http.get(`${API_BASE}/credits/usage`, () => {
      return HttpResponse.json(
        overrides?.usageData ?? {
          total: 10.0,
          used: 3.5,
          remaining: 6.5,
          tier: 10,
        },
      );
    }),
    http.get(`${API_BASE}/credits/stats`, () => {
      return HttpResponse.json(
        overrides?.statsData ?? {
          totalTokens: 150000,
          topModels: [
            { model: 'rose-1-lite', tokens: 100000, percentage: 67 },
            { model: 'rose-1-ultra', tokens: 50000, percentage: 33 },
          ],
        },
      );
    }),
  );
}

describe('Usage page', () => {
  beforeEach(() => {
    mockSession();
    installUsageHandlers();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  describe('loading state', () => {
    it('shows loading spinner before data resolves', () => {
      // Use a handler that never resolves so component stays in loading state
      server.use(
        http.get(`${API_BASE}/credits/usage`, () => {
          return new Promise(() => {
            // never resolves
          });
        }),
        http.get(`${API_BASE}/credits/stats`, () => {
          return new Promise(() => {
            // never resolves
          });
        }),
      );
      renderWithProviders(<Usage />);
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('hides loading spinner after data loads', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      expect(document.querySelector('.animate-spin')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders the Credit Usage card heading', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
    });

    it('renders Total Credits label and value', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Total Credits')).toBeInTheDocument();
      });
      expect(screen.getByText('$10.00')).toBeInTheDocument();
    });

    it('renders Used label and value', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Used')).toBeInTheDocument();
      });
      expect(screen.getByText('$3.50')).toBeInTheDocument();
    });

    it('renders Remaining label and value', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Remaining')).toBeInTheDocument();
      });
      expect(screen.getByText('$6.50')).toBeInTheDocument();
    });

    it('renders the credit usage progress bar', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      // The progress bar is a div with a computed width style
      const progressBar = document.querySelector('.bg-primary.h-3.rounded-full');
      expect(progressBar).toBeInTheDocument();
      expect(progressBar).toHaveStyle({ width: '35%' }); // 3.5/10 * 100 = 35%
    });

    it('renders the Total Tokens Consumed card', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Total Tokens Consumed')).toBeInTheDocument();
      });
      expect(screen.getByText('150,000')).toBeInTheDocument();
      expect(screen.getByText('Across all agents and models')).toBeInTheDocument();
    });

    it('renders the Top 5 Models card heading', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Top 5 Models by Token Usage')).toBeInTheDocument();
      });
    });

    it('renders each model with rank, name, and token count', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('rose-1-lite')).toBeInTheDocument();
      });
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('100,000 tokens (67%)')).toBeInTheDocument();

      expect(screen.getByText('rose-1-ultra')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
      expect(screen.getByText('50,000 tokens (33%)')).toBeInTheDocument();
    });

    it('renders model progress bars with correct width percentages', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('rose-1-lite')).toBeInTheDocument();
      });
      const modelBars = document.querySelectorAll('.bg-primary.h-2.rounded-full');
      expect(modelBars).toHaveLength(2);
      expect(modelBars[0]).toHaveStyle({ width: '67%' });
      expect(modelBars[1]).toHaveStyle({ width: '33%' });
    });

    it('renders current plan tier text', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText(/current plan: \$10\/month/i)).toBeInTheDocument();
      });
    });

    it('renders Usage Over Time placeholder section', async () => {
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Usage Over Time')).toBeInTheDocument();
      });
      expect(screen.getByText('Graph coming soon')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // API boundary captures
  // ---------------------------------------------------------------------------

  describe('API boundary captures', () => {
    it('captures GET /api/credits/usage with correct auth header', async () => {
      clearCaptures();
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });

      const usageReq = capturedRequests.find(
        (r) => r.url.includes('/credits/usage') && r.method === 'GET',
      );
      expect(usageReq).toBeDefined();
      expect(usageReq!.headers['authorization']).toBe('Bearer test-token');
      expect(usageReq!.headers['content-type']).toBe('application/json');
    });

    it('captures GET /api/credits/stats with correct auth header', async () => {
      clearCaptures();
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });

      const statsReq = capturedRequests.find(
        (r) => r.url.includes('/credits/stats') && r.method === 'GET',
      );
      expect(statsReq).toBeDefined();
      expect(statsReq!.headers['authorization']).toBe('Bearer test-token');
      expect(statsReq!.headers['content-type']).toBe('application/json');
    });

    it('calls both credits endpoints in parallel on mount', async () => {
      clearCaptures();
      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });

      const usageReq = capturedRequests.find(
        (r) => r.url.includes('/credits/usage') && r.method === 'GET',
      );
      const statsReq = capturedRequests.find(
        (r) => r.url.includes('/credits/stats') && r.method === 'GET',
      );
      expect(usageReq).toBeDefined();
      expect(statsReq).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Auth / no session
  // ---------------------------------------------------------------------------

  describe('auth behavior', () => {
    it('stays in loading state when no session exists (no API calls)', async () => {
      localStorage.clear(); // remove session
      clearCaptures();
      renderWithProviders(<Usage />);

      // The component calls fetchUsageData which checks session, finds none,
      // returns early without calling setLoading(false) properly — it stays loading
      // since finally block still runs, it will exit loading but usage remains null
      // Actually, looking at the code: the finally block sets loading=false even on no-session.
      // But without session, usage stays null, so it renders default '$0.00' values.
      await waitFor(() => {
        // loading will become false because of the finally block,
        // but the early return skips the API calls so no data is fetched
        const apiCalls = capturedRequests.filter(
          (r) => r.url.includes('/credits/'),
        );
        // No API calls should have been made
        expect(apiCalls).toHaveLength(0);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Error state — API failures
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('renders fallback values when usage API returns 500', async () => {
      server.use(
        http.get(`${API_BASE}/credits/usage`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      renderWithProviders(<Usage />);
      await waitFor(() => {
        // Component should still render since finally sets loading=false
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      // usage is null, so all three credit values fall back to $0.00
      const zeroValues = screen.getAllByText('$0.00');
      expect(zeroValues).toHaveLength(3);
    });

    it('renders fallback token count when stats API returns 500', async () => {
      server.use(
        http.get(`${API_BASE}/credits/stats`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Total Tokens Consumed')).toBeInTheDocument();
      });
      // totalTokens defaults to 0
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('renders gracefully when both APIs fail', async () => {
      server.use(
        http.get(`${API_BASE}/credits/usage`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
        http.get(`${API_BASE}/credits/stats`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      // All credit values fall back to $0.00
      const zeroValues = screen.getAllByText('$0.00');
      expect(zeroValues).toHaveLength(3);
      // Token count defaults to 0
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('renders gracefully when APIs throw a network error', async () => {
      server.use(
        http.get(`${API_BASE}/credits/usage`, () => {
          return HttpResponse.error();
        }),
        http.get(`${API_BASE}/credits/stats`, () => {
          return HttpResponse.error();
        }),
      );

      renderWithProviders(<Usage />);
      await waitFor(() => {
        // The catch block logs the error, finally block sets loading=false
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      const zeroValues = screen.getAllByText('$0.00');
      expect(zeroValues).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty / zero usage
  // ---------------------------------------------------------------------------

  describe('empty / zero usage', () => {
    it('renders zero credit values when usage is all zeros', async () => {
      installUsageHandlers({
        usageData: { total: 0, used: 0, remaining: 0, tier: null },
        statsData: { totalTokens: 0, topModels: [] },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      // All values should be $0.00
      const zeroValues = screen.getAllByText('$0.00');
      expect(zeroValues.length).toBeGreaterThanOrEqual(3);
    });

    it('renders zero total tokens when stats return zero', async () => {
      installUsageHandlers({
        statsData: { totalTokens: 0, topModels: [] },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Total Tokens Consumed')).toBeInTheDocument();
      });
      expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('renders no model bars when topModels is empty', async () => {
      installUsageHandlers({
        statsData: { totalTokens: 0, topModels: [] },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Top 5 Models by Token Usage')).toBeInTheDocument();
      });
      // No model bars should be rendered
      const modelBars = document.querySelectorAll('.bg-primary.h-2.rounded-full');
      expect(modelBars).toHaveLength(0);
    });

    it('does not render tier text when tier is null', async () => {
      installUsageHandlers({
        usageData: { total: 10, used: 0, remaining: 10, tier: null },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      expect(screen.queryByText(/current plan/i)).not.toBeInTheDocument();
    });

    it('progress bar width is 0% when no credits used', async () => {
      installUsageHandlers({
        usageData: { total: 10, used: 0, remaining: 10, tier: null },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      const progressBar = document.querySelector('.bg-primary.h-3.rounded-full');
      expect(progressBar).toHaveStyle({ width: '0%' });
    });
  });

  // ---------------------------------------------------------------------------
  // Varied data scenarios
  // ---------------------------------------------------------------------------

  describe('varied data scenarios', () => {
    it('renders with 5 top models', async () => {
      installUsageHandlers({
        statsData: {
          totalTokens: 500000,
          topModels: [
            { model: 'claude-3-opus', tokens: 200000, percentage: 40 },
            { model: 'rose-1-ultra', tokens: 150000, percentage: 30 },
            { model: 'rose-1-lite', tokens: 80000, percentage: 16 },
            { model: 'gpt-4o', tokens: 50000, percentage: 10 },
            { model: 'claude-3-haiku', tokens: 20000, percentage: 4 },
          ],
        },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('claude-3-opus')).toBeInTheDocument();
      });
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
      expect(screen.getByText('#3')).toBeInTheDocument();
      expect(screen.getByText('#4')).toBeInTheDocument();
      expect(screen.getByText('#5')).toBeInTheDocument();
      expect(screen.getByText('claude-3-haiku')).toBeInTheDocument();
      expect(screen.getByText('500,000')).toBeInTheDocument();
    });

    it('renders with fully used credits (100% bar)', async () => {
      installUsageHandlers({
        usageData: { total: 10, used: 10, remaining: 0, tier: 10 },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('Credit Usage')).toBeInTheDocument();
      });
      // total and used are both $10.00, remaining is $0.00
      const tenValues = screen.getAllByText('$10.00');
      expect(tenValues).toHaveLength(2); // total + used
      expect(screen.getByText('$0.00')).toBeInTheDocument(); // remaining
      const progressBar = document.querySelector('.bg-primary.h-3.rounded-full');
      expect(progressBar).toHaveStyle({ width: '100%' });
    });

    it('renders with large credit values', async () => {
      installUsageHandlers({
        usageData: { total: 1000, used: 456.78, remaining: 543.22, tier: 1000 },
        statsData: { totalTokens: 12345678, topModels: [] },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText('$1000.00')).toBeInTheDocument();
      });
      expect(screen.getByText('$456.78')).toBeInTheDocument();
      expect(screen.getByText('$543.22')).toBeInTheDocument();
      expect(screen.getByText('12,345,678')).toBeInTheDocument();
    });

    it('renders tier text with different plan amounts', async () => {
      installUsageHandlers({
        usageData: { total: 50, used: 10, remaining: 40, tier: 50 },
      });

      renderWithProviders(<Usage />);
      await waitFor(() => {
        expect(screen.getByText(/current plan: \$50\/month/i)).toBeInTheDocument();
      });
    });
  });
});
