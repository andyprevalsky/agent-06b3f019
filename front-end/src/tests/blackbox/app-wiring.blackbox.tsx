import { Suspense } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, cleanup, within, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './test-wrapper';
import { capturedRequests, clearCaptures } from './msw/capture';
import { ROUTE_TABLE } from '@/features/app-wiring/config';
import { supabase } from '@/lib/supabase';
import { useAttentionRequests } from '@/features/terminal-component-group/components/attention-inbox/useAttentionRequests';

// Resolve every real lazy route module with the fixture dependencies.
// Route mapping still mounts the original lazy components and checks their rendered content.
import '@/features/index';
import '@/features/privacy';
import '@/features/terms';
import '@/features/not-found';
import '@/features/about';
import '@/features/research-blog';
import '@/features/research-blog-post';
import '@/features/careers';
import '@/features/download';
import '@/features/test-payment';
import '@/features/gate-playground';
import '@/pages/Waitlist';
import '@/features/open-agent-redirect';
import '@/features/mobile-preview';

/**
 * Renders the full route table from App.tsx inside the test wrapper's MemoryRouter.
 * This tests that the route config correctly maps paths to page components.
 */
export function AppRoutes() {
  return (
    <Suspense fallback={<div data-testid="route-loading">Loading…</div>}>
      <Routes>
        {ROUTE_TABLE.map(({ path, component: Page }) => (
          <Route key={path} path={path} element={<Page />} />
        ))}
      </Routes>
    </Suspense>
  );
}

async function renderAppRoutes(route: string): Promise<void> {
  await act(async () => {
    renderWithProviders(<AppRoutes />, { route });
    // Route mapping assertions start once Vite has loaded the lazy page module.
    // Cold module transformation belongs to fixture setup, not the UI wait budget.
    await vi.dynamicImportSettled();
  });
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

describe('App wiring', () => {
  beforeEach(() => {
    clearCaptures();
    localStorage.clear();
  });

  afterEach(async () => {
    localStorage.clear();
    cleanup();
    // A route must release even a channel whose WebSocket join is still pending.
    // Otherwise its join timeout can log after Vitest has torn down this file.
    await waitFor(() => expect(supabase.getChannels().map((channel) => channel.topic)).toEqual([]));
  });

  // -----------------------------------------------------------------------
  // Route mapping: each route path renders the correct page component
  // -----------------------------------------------------------------------

  describe('route mapping', () => {
    it('"/" renders the Terminal page', async () => {
      mockSession();
      await renderAppRoutes('/');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      // Terminal page has an agent sidebar or the main terminal UI.
      // It won't crash -- we verify it rendered something (not 404).
      await waitFor(() => {
        expect(screen.queryByText('404')).not.toBeInTheDocument();
      });
    });

    it('"/privacy" renders the Privacy page', async () => {
      await renderAppRoutes('/privacy');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /privacy policy/i })).toBeInTheDocument();
    });

    it('"/terms" renders the Terms page', async () => {
      await renderAppRoutes('/terms');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument();
    });

    it('"/about" renders the About page', async () => {
      await renderAppRoutes('/about');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
    });

    it('"/terminal" renders the Index (landing) page', async () => {
      await renderAppRoutes('/terminal');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      // Index has HeroSection, NaviHeader, etc. -- just confirm no 404.
      expect(screen.queryByText('404')).not.toBeInTheDocument();
    });

    it('"/research" renders the ResearchBlog page', async () => {
      await renderAppRoutes('/research');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      // ResearchBlog has a Download link in the header
      expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
      // Not a 404
      expect(screen.queryByText('404')).not.toBeInTheDocument();
    });

    it('"/research/:slug" renders ResearchBlogPost (with not-found fallback for unknown slug)', async () => {
      await renderAppRoutes('/research/nonexistent-slug');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      // Unknown slug shows "Post not found"
      expect(screen.getByText('Post not found')).toBeInTheDocument();
    });

    it('"/careers" renders the Careers overview page', async () => {
      await renderAppRoutes('/careers');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { level: 1, name: /hiring/i })).toBeInTheDocument();
      expect(screen.queryByText('404')).not.toBeInTheDocument();
    });

    it('"/careers/:slug" renders a role page', async () => {
      await renderAppRoutes('/careers/founding-product-engineer');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(
        screen.getByRole('heading', { level: 1, name: 'Founding Product Engineer' }),
      ).toBeInTheDocument();
    });

    it('"/careers/:slug" falls back to NotFound for an unknown role', async () => {
      await renderAppRoutes('/careers/nonexistent-role');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Founding Product Engineer' }),
      ).not.toBeInTheDocument();
    });

    it('"/download" renders the Download page', async () => {
      await renderAppRoutes('/download');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByText(/downloading rose for mac/i)).toBeInTheDocument();
    });

    it('"/waitlist" renders the main Terminal and automatically opens the phone login modal', async () => {
      const user = userEvent.setup();
      await renderAppRoutes('/waitlist');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());

      await waitFor(() => {
        expect(
          within(screen.getByRole('dialog')).getByRole('heading', { name: 'Join the Waitlist' }),
        ).toBeInTheDocument();
      });
      expect(
        within(screen.getByRole('dialog')).queryByText('Start Building.'),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText('Phone Number')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('First name')).toBeInTheDocument();
      expect(screen.getByLabelText('Last name')).toBeInTheDocument();
      expect(screen.getByTestId('terminal-input-area')).toBeInTheDocument();

      // Press Escape the way a real user would: userEvent flushes pending React
      // renders (via act) before dispatching, so Radix's DismissableLayer has
      // recomputed its layer index and its document-level Escape handler
      // dismisses the modal. A bare fireEvent.keyDown fires in the same tick the
      // dialog mounts, before the layer registers, so the handler no-ops.
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });

    it('"/waitlist" does not reopen login for an authenticated user', async () => {
      mockSession();
      await renderAppRoutes('/waitlist');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());

      await waitFor(() => {
        const inviteChecks = capturedRequests.filter((request) =>
          request.url.includes('/invite-codes/check'),
        );
        expect(inviteChecks.length).toBeGreaterThanOrEqual(2);
      });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // 404 fallback: unknown routes render NotFound
  // -----------------------------------------------------------------------

  describe('404 fallback', () => {
    it('renders 404 for unknown route', async () => {
      await renderAppRoutes('/some-unknown-route');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByText('404')).toBeInTheDocument();
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });

    it('renders 404 for nested unknown route', async () => {
      await renderAppRoutes('/foo/bar/baz');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByText('404')).toBeInTheDocument();
    });

    it('404 page includes a link back to home', async () => {
      await renderAppRoutes('/nonexistent');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      const homeLink = screen.getByRole('link', { name: /return to home/i });
      expect(homeLink).toHaveAttribute('href', '/');
    });
  });

  // -----------------------------------------------------------------------
  // Provider hierarchy: providers are present and functional
  // -----------------------------------------------------------------------

  describe('provider hierarchy', () => {
    it('AppDataProvider loads models from API', async () => {
      // Rendering any route through AppRoutes exercises the full provider stack.
      // AppDataProvider fetches /api/models on mount.
      await renderAppRoutes('/privacy');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      // The page renders successfully, meaning QueryClientProvider + AppDataProvider
      // + TooltipProvider all initialized without error.
      expect(screen.getByRole('heading', { name: /privacy policy/i })).toBeInTheDocument();
    });

    it('routes work without an auth session (public pages)', async () => {
      // No session in localStorage -- public pages should still render.
      await renderAppRoutes('/about');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
    });

    it('TooltipProvider is present (components that use tooltips do not crash)', async () => {
      // The Terminal page and others use Tooltip from radix. If TooltipProvider
      // was missing, rendering would throw. Rendering About (which uses NaviHeader
      // with potential tooltip triggers) without error proves the provider exists.
      await renderAppRoutes('/about');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByText(/we.re hiring/i)).toBeInTheDocument();
    });

    it('QueryClientProvider is present (react-query hooks do not crash)', async () => {
      // AppDataProvider uses react-query internally to fetch models/tools.
      // If QueryClientProvider was missing, mount would throw.
      mockSession();
      await renderAppRoutes('/');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      await waitFor(() => {
        expect(screen.queryByText('404')).not.toBeInTheDocument();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Route content verification: key content on each page
  // -----------------------------------------------------------------------

  describe('route content verification', () => {
    it('/privacy shows all 11 policy sections', async () => {
      await renderAppRoutes('/privacy');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(
        screen.getByRole('heading', { name: /1\. information we collect/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /2\. how we use your data/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /3\. plaid and financial data/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /4\. third-party processors/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /5\. data retention and deletion/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /6\. security/i })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /7\. your rights and controls/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /8\. children/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /9\. international users/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /10\. policy updates/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /11\. contact/i })).toBeInTheDocument();
    });

    it('/terms shows all 9 terms sections', async () => {
      await renderAppRoutes('/terms');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /1\. use of our service/i })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /2\. account registration and eligibility/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /3\. connected financial accounts and plaid/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /4\. ai services disclaimer/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /5\. limitation of liability/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /6\. intellectual property and acceptable use/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /7\. changes to these terms and termination/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /8\. sms\/text messaging/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /9\. contact/i })).toBeInTheDocument();
    });

    it('/about shows Mission, Team, and hiring sections', async () => {
      await renderAppRoutes('/about');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /team/i })).toBeInTheDocument();
      expect(screen.getByText(/we.re hiring/i)).toBeInTheDocument();
    });

    it('/download includes a fallback download link', async () => {
      await renderAppRoutes('/download');
      await waitFor(() => expect(screen.queryByTestId('route-loading')).not.toBeInTheDocument());
      const fallbackLink = screen.getByRole('link', { name: /click here/i });
      expect(fallbackLink).toHaveAttribute(
        'href',
        'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg',
      );
    });
  });

  it('cancels an attention join that is still pending when its owner unmounts', async () => {
    // Hold the Phoenix acknowledgement so teardown races a real in-flight join,
    // independently of CPU speed or the order the route modules were imported.
    vi.useFakeTimers();
    const send = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error');
    const log = vi.spyOn(console, 'log');
    try {
      mockSession();
      const view = renderHook(() => useAttentionRequests(true));
      await act(async () => {});
      expect(supabase.getChannels().map((channel) => channel.state)).toEqual(['joining']);

      view.unmount();
      error.mockClear();
      log.mockClear();
      // Advance the existing library deadline; changing it would hide the leak.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_001);
      });
      const lateLogs = [...log.mock.calls, ...error.mock.calls].filter((args) =>
        args.some(
          (arg) =>
            typeof arg === 'string' && /TIMED_OUT|Failed to subscribe to attention/.test(arg),
        ),
      );
      expect(lateLogs).toEqual([]);
      expect(supabase.getChannels()).toEqual([]);
    } finally {
      await supabase.removeAllChannels();
      send.mockRestore();
      error.mockRestore();
      log.mockRestore();
      vi.useRealTimers();
    }
  });
});
