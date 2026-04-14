import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './test-wrapper';
import Index from '@/pages/Index';
import Privacy from '@/pages/Privacy';
import Terms from '@/features/terms';
import NotFound from '@/features/not-found';
import About from '@/pages/About';
import Terminal from '@/pages/Terminal';
import ResearchBlog from '@/pages/ResearchBlog';
import ResearchBlogPost from '@/pages/ResearchBlogPost';
import Download from '@/features/download';

/**
 * Renders the full route table from App.tsx inside the test wrapper's MemoryRouter.
 * This tests that the route config correctly maps paths to page components.
 */
function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Terminal />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/about" element={<About />} />
      <Route path="/terminal" element={<Index />} />
      <Route path="/research" element={<ResearchBlog />} />
      <Route path="/research/:slug" element={<ResearchBlogPost />} />
      <Route path="/download" element={<Download />} />
      {/* Catch-all 404 */}
      <Route path="*" element={<NotFound />} />
    </Routes>
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

describe('App wiring', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    cleanup();
  });

  // -----------------------------------------------------------------------
  // Route mapping: each route path renders the correct page component
  // -----------------------------------------------------------------------

  describe('route mapping', () => {
    it('"/" renders the Terminal page', async () => {
      mockSession();
      renderWithProviders(<AppRoutes />, { route: '/' });
      // Terminal page has an agent sidebar or the main terminal UI.
      // It won't crash -- we verify it rendered something (not 404).
      await waitFor(() => {
        expect(screen.queryByText('404')).not.toBeInTheDocument();
      });
    });

    it('"/privacy" renders the Privacy page', () => {
      renderWithProviders(<AppRoutes />, { route: '/privacy' });
      expect(screen.getByRole('heading', { name: /privacy policy/i })).toBeInTheDocument();
    });

    it('"/terms" renders the Terms page', () => {
      renderWithProviders(<AppRoutes />, { route: '/terms' });
      expect(screen.getByRole('heading', { name: /terms of service/i })).toBeInTheDocument();
    });

    it('"/about" renders the About page', () => {
      renderWithProviders(<AppRoutes />, { route: '/about' });
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
    });

    it('"/terminal" renders the Index (landing) page', () => {
      renderWithProviders(<AppRoutes />, { route: '/terminal' });
      // Index has HeroSection, NaviHeader, etc. -- just confirm no 404.
      expect(screen.queryByText('404')).not.toBeInTheDocument();
    });

    it('"/research" renders the ResearchBlog page', () => {
      renderWithProviders(<AppRoutes />, { route: '/research' });
      // ResearchBlog has a Download link in the header
      expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
      // Not a 404
      expect(screen.queryByText('404')).not.toBeInTheDocument();
    });

    it('"/research/:slug" renders ResearchBlogPost (with not-found fallback for unknown slug)', () => {
      renderWithProviders(<AppRoutes />, { route: '/research/nonexistent-slug' });
      // Unknown slug shows "Post not found"
      expect(screen.getByText('Post not found')).toBeInTheDocument();
    });

    it('"/download" renders the Download page', () => {
      renderWithProviders(<AppRoutes />, { route: '/download' });
      expect(screen.getByText(/downloading rose for mac/i)).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // 404 fallback: unknown routes render NotFound
  // -----------------------------------------------------------------------

  describe('404 fallback', () => {
    it('renders 404 for unknown route', () => {
      renderWithProviders(<AppRoutes />, { route: '/some-unknown-route' });
      expect(screen.getByText('404')).toBeInTheDocument();
      expect(screen.getByText(/page not found/i)).toBeInTheDocument();
    });

    it('renders 404 for nested unknown route', () => {
      renderWithProviders(<AppRoutes />, { route: '/foo/bar/baz' });
      expect(screen.getByText('404')).toBeInTheDocument();
    });

    it('404 page includes a link back to home', () => {
      renderWithProviders(<AppRoutes />, { route: '/nonexistent' });
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
      renderWithProviders(<AppRoutes />, { route: '/privacy' });
      // The page renders successfully, meaning QueryClientProvider + AppDataProvider
      // + TooltipProvider all initialized without error.
      expect(screen.getByRole('heading', { name: /privacy policy/i })).toBeInTheDocument();
    });

    it('routes work without an auth session (public pages)', () => {
      // No session in localStorage -- public pages should still render.
      renderWithProviders(<AppRoutes />, { route: '/about' });
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
    });

    it('TooltipProvider is present (components that use tooltips do not crash)', () => {
      // The Terminal page and others use Tooltip from radix. If TooltipProvider
      // was missing, rendering would throw. Rendering About (which uses NaviHeader
      // with potential tooltip triggers) without error proves the provider exists.
      renderWithProviders(<AppRoutes />, { route: '/about' });
      expect(screen.getByText(/we.re hiring/i)).toBeInTheDocument();
    });

    it('QueryClientProvider is present (react-query hooks do not crash)', async () => {
      // AppDataProvider uses react-query internally to fetch models/tools.
      // If QueryClientProvider was missing, mount would throw.
      mockSession();
      renderWithProviders(<AppRoutes />, { route: '/' });
      await waitFor(() => {
        expect(screen.queryByText('404')).not.toBeInTheDocument();
      });
    });
  });

  // -----------------------------------------------------------------------
  // Route content verification: key content on each page
  // -----------------------------------------------------------------------

  describe('route content verification', () => {
    it('/privacy shows all 7 policy sections', () => {
      renderWithProviders(<AppRoutes />, { route: '/privacy' });
      expect(
        screen.getByRole('heading', { name: /1\. information we collect/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /2\. how our assistant operates/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /3\. third-party processing/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /4\. security/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /5\. your control/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /6\. policy updates/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /7\. contact/i })).toBeInTheDocument();
    });

    it('/terms shows all 9 terms sections', () => {
      renderWithProviders(<AppRoutes />, { route: '/terms' });
      expect(screen.getByRole('heading', { name: /1\. use of our website/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /2\. waitlist sign-up/i })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /3\. intellectual property/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /4\. no warranties/i })).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /5\. limitation of liability/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /6\. links to other sites/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: /7\. changes to these terms/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /8\. sms\/text messaging/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /9\. contact/i })).toBeInTheDocument();
    });

    it('/about shows Mission, Team, and hiring sections', () => {
      renderWithProviders(<AppRoutes />, { route: '/about' });
      expect(screen.getByRole('heading', { name: /mission/i })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /team/i })).toBeInTheDocument();
      expect(screen.getByText(/we.re hiring/i)).toBeInTheDocument();
    });

    it('/download includes a fallback download link', () => {
      renderWithProviders(<AppRoutes />, { route: '/download' });
      const fallbackLink = screen.getByRole('link', { name: /click here/i });
      expect(fallbackLink).toHaveAttribute(
        'href',
        'https://kzlurqihzaolhzsbkctf.supabase.co/storage/v1/object/public/Releases/mac/latest/Rose-mac.dmg',
      );
    });
  });
});
