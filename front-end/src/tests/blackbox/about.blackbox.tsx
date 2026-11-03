import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import About from '@/pages/About';

describe('About page', () => {
  beforeEach(() => {
    // Reset document title before each test
    document.title = '';
  });

  // ─── SEO / Meta ────────────────────────────────────────────────

  describe('SEO and metadata', () => {
    it('sets the document title to "About Rose Labs"', async () => {
      renderWithProviders(<About />);
      await waitFor(() => {
        expect(document.title).toBe('About Rose Labs');
      });
    });

    it('sets the meta description tag', async () => {
      renderWithProviders(<About />);
      await waitFor(() => {
        const meta = document.querySelector('meta[name="description"]');
        expect(meta).not.toBeNull();
        expect(meta!.getAttribute('content')).toContain('Rose Labs');
        expect(meta!.getAttribute('content')).toContain('Artificial Life');
      });
    });

    it('sets the canonical link element', async () => {
      renderWithProviders(<About />);
      await waitFor(() => {
        const link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
        expect(link).not.toBeNull();
        expect(link!.href).toBeTruthy();
      });
    });
  });

  // ─── Mission Section ──────────────────────────────────────────

  describe('Mission section', () => {
    it('renders the Mission heading as h1', () => {
      renderWithProviders(<About />);
      const heading = screen.getByRole('heading', { name: /mission/i, level: 1 });
      expect(heading).toBeInTheDocument();
    });

    it('renders the mission statement about Artificial Life', () => {
      renderWithProviders(<About />);
      expect(screen.getByText(/create artificial life/i)).toBeInTheDocument();
    });

    it('includes the full mission description about personal journey', () => {
      renderWithProviders(<About />);
      expect(screen.getByText(/super intelligent companion/i)).toBeInTheDocument();
    });
  });

  it('explains Google permissions and links to legal pages and support', () => {
    renderWithProviders(<About />);
    expect(screen.getByRole('heading', { name: /what rose does/i })).toBeInTheDocument();
    expect(
      screen.getByText(/google calendar events \(to view, create, and update events/i),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /privacy policy/i })[0]).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(screen.getAllByRole('link', { name: /terms of service/i })[0]).toHaveAttribute(
      'href',
      '/terms',
    );
    expect(screen.getByRole('link', { name: 'security@roselabs.ai' })).toHaveAttribute(
      'href',
      'mailto:security@roselabs.ai',
    );
  });

  // ─── Team Section ─────────────────────────────────────────────

  describe('Team section', () => {
    it('renders the Team heading as h2', () => {
      renderWithProviders(<About />);
      const heading = screen.getByRole('heading', { name: /team/i, level: 2 });
      expect(heading).toBeInTheDocument();
    });

    it('renders the team member image with alt text', () => {
      renderWithProviders(<About />);
      const img = screen.getByAltText(/rose labs team member speaking on stage/i);
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', expect.stringContaining('lovable-uploads'));
    });

    it('renders the team image with lazy loading', () => {
      renderWithProviders(<About />);
      const img = screen.getByAltText(/rose labs team member speaking on stage/i);
      expect(img).toHaveAttribute('loading', 'lazy');
      expect(img).toHaveAttribute('decoding', 'async');
    });

    it('renders founder introduction text', () => {
      renderWithProviders(<About />);
      expect(
        screen.getByText(/i'm andy, the solo founder and builder behind rose labs/i),
      ).toBeInTheDocument();
    });

    it('renders founder description about mission and values', () => {
      renderWithProviders(<About />);
      expect(
        screen.getByText(/passionate software engineer, artist, and creator/i),
      ).toBeInTheDocument();
    });

    it("renders LinkedIn link pointing to Andy's profile", () => {
      renderWithProviders(<About />);
      const link = screen.getByRole('link', { name: /linkedin/i });
      expect(link).toBeInTheDocument();
      expect(link).toHaveAttribute('href', 'https://linkedin.com/in/andyprevalsky');
    });

    it('LinkedIn link opens in a new tab with security attributes', () => {
      renderWithProviders(<About />);
      const link = screen.getByRole('link', { name: /linkedin/i });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    });
  });

  // ─── Hiring Section ───────────────────────────────────────────

  describe('Hiring section', () => {
    it('renders the hiring heading as h2', async () => {
      renderWithProviders(<About />);
      await waitFor(() => {
        const heading = screen.getByRole('heading', { name: /hiring/i, level: 2 });
        expect(heading).toBeInTheDocument();
      });
    });

    it('renders the hiring call-to-action description', () => {
      renderWithProviders(<About />);
      expect(
        screen.getByText(
          /help us build artificial life, frontier ai, agents, and delightful hardware/i,
        ),
      ).toBeInTheDocument();
    });

    it('renders the "Get in touch" button', () => {
      renderWithProviders(<About />);
      const button = screen.getByRole('button', { name: /get in touch/i });
      expect(button).toBeInTheDocument();
    });
  });

  // ─── Contact Modal ────────────────────────────────────────────

  describe('Contact modal', () => {
    it('opens the contact modal when "Get in touch" is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<About />);

      await user.click(screen.getByRole('button', { name: /get in touch/i }));
      await waitFor(() => {
        expect(screen.getByText(/come help us build the next apple/i)).toBeInTheDocument();
      });
    });

    it('shows the "Contact Us" title in the modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<About />);

      await user.click(screen.getByRole('button', { name: /get in touch/i }));
      await waitFor(() => {
        expect(screen.getByText(/contact us/i)).toBeInTheDocument();
      });
    });

    it('displays the email address in the modal', async () => {
      const user = userEvent.setup();
      renderWithProviders(<About />);

      await user.click(screen.getByRole('button', { name: /get in touch/i }));
      await waitFor(() => {
        expect(screen.getByText('andy@hinavi.ai')).toBeInTheDocument();
      });
    });

    it('copies email to clipboard when the email button is clicked', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      const user = userEvent.setup({
        writeToClipboard: true,
      });

      // Mock navigator.clipboard before rendering
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: writeTextMock },
        writable: true,
        configurable: true,
      });

      renderWithProviders(<About />);

      await user.click(screen.getByRole('button', { name: /get in touch/i }));
      await waitFor(() => {
        expect(screen.getByText('andy@hinavi.ai')).toBeInTheDocument();
      });

      // Click the email copy button (the button containing the email text)
      const emailButton = screen.getByText('andy@hinavi.ai').closest('button');
      expect(emailButton).not.toBeNull();
      await user.click(emailButton!);

      await waitFor(() => {
        expect(writeTextMock).toHaveBeenCalledWith('andy@hinavi.ai');
      });
    });

    it('uses the custom subtitle passed from the hiring section', async () => {
      const user = userEvent.setup();
      renderWithProviders(<About />);

      await user.click(screen.getByRole('button', { name: /get in touch/i }));
      await waitFor(() => {
        // The About page passes subtitle="Come help us build the next Apple."
        expect(screen.getByText(/come help us build the next apple/i)).toBeInTheDocument();
      });
      // The default subtitle should NOT be present
      expect(
        screen.queryByText(/have questions\? we'd love to hear from you/i),
      ).not.toBeInTheDocument();
    });
  });

  // ─── Header (NaviHeader) ──────────────────────────────────────

  describe('Header navigation', () => {
    it('renders the Rose logo/brand link in the header', () => {
      renderWithProviders(<About />);
      // The header has a link to "/" with "Rose" text
      const headerElement = document.getElementById('site-header');
      expect(headerElement).not.toBeNull();
      const headerScope = within(headerElement!);
      const homeLink = headerScope.getByRole('link', { name: /rose/i });
      expect(homeLink).toHaveAttribute('href', '/');
    });

    it('renders the Features navigation button in the header', () => {
      renderWithProviders(<About />);
      const headerElement = document.getElementById('site-header');
      const headerScope = within(headerElement!);
      expect(headerScope.getByRole('button', { name: /features/i })).toBeInTheDocument();
    });

    it('renders the Join Waitlist navigation button in the header', () => {
      renderWithProviders(<About />);
      const headerElement = document.getElementById('site-header');
      const headerScope = within(headerElement!);
      // Header has multiple "Join Waitlist" buttons (desktop nav + mobile CTA)
      const waitlistButtons = headerScope.getAllByRole('button', { name: /join waitlist/i });
      expect(waitlistButtons.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the Research link in the header', () => {
      renderWithProviders(<About />);
      const headerElement = document.getElementById('site-header');
      const headerScope = within(headerElement!);
      const researchLink = headerScope.getByRole('link', { name: /research/i });
      expect(researchLink).toHaveAttribute('href', '/research');
    });

    it('renders the About link in the header', () => {
      renderWithProviders(<About />);
      const headerElement = document.getElementById('site-header');
      const headerScope = within(headerElement!);
      const aboutLink = headerScope.getByRole('link', { name: /about/i });
      expect(aboutLink).toHaveAttribute('href', '/about');
    });
  });

  // ─── Footer (NaviFooter) ──────────────────────────────────────

  describe('Footer', () => {
    it('renders the Rose Labs logo link in the footer', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      expect(footer).not.toBeNull();
      const footerScope = within(footer!);
      const logoLink = footerScope.getByRole('link', { name: /rose labs/i });
      expect(logoLink).toHaveAttribute('href', '/');
    });

    it('renders the tagline in the footer', () => {
      renderWithProviders(<About />);
      expect(screen.getByText(/your personal superintelligence/i)).toBeInTheDocument();
    });

    it('renders Product section heading in the footer', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      expect(footerScope.getByText('Product')).toBeInTheDocument();
    });

    it('renders Features button in the footer Product section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      expect(footerScope.getByRole('button', { name: /features/i })).toBeInTheDocument();
    });

    it('renders Join Waitlist button in the footer Product section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      expect(footerScope.getByRole('button', { name: /join waitlist/i })).toBeInTheDocument();
    });

    it('renders Company section heading in the footer', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      expect(footerScope.getByText('Company')).toBeInTheDocument();
    });

    it('renders About link in the footer Company section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      const aboutLink = footerScope.getByRole('link', { name: /^about$/i });
      expect(aboutLink).toHaveAttribute('href', '/about');
    });

    it('renders Privacy link in the footer Company section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      // Multiple privacy links exist (Company section + bottom bar), get the one in the list
      const privacyLinks = footerScope.getAllByRole('link', { name: /privacy/i });
      expect(privacyLinks.length).toBeGreaterThanOrEqual(1);
      expect(privacyLinks[0]).toHaveAttribute('href', '/privacy');
    });

    it('renders Terms link in the footer Company section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      const termsLinks = footerScope.getAllByRole('link', { name: /terms/i });
      expect(termsLinks.length).toBeGreaterThanOrEqual(1);
      expect(termsLinks[0]).toHaveAttribute('href', '/terms');
    });

    it('renders the Contact button in the footer Company section', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      expect(footerScope.getByRole('button', { name: /contact/i })).toBeInTheDocument();
    });

    it('renders the copyright notice', () => {
      renderWithProviders(<About />);
      expect(screen.getByText(/© 2026 rose labs/i)).toBeInTheDocument();
    });

    it('renders Privacy Policy link in the bottom bar', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      const policyLink = footerScope.getByRole('link', { name: /privacy policy/i });
      expect(policyLink).toHaveAttribute('href', '/privacy');
    });

    it('renders Terms of Service link in the bottom bar', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      const tosLink = footerScope.getByRole('link', { name: /terms of service/i });
      expect(tosLink).toHaveAttribute('href', '/terms');
    });

    it('renders Cookie Policy link in the bottom bar', () => {
      renderWithProviders(<About />);
      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      const cookieLink = footerScope.getByRole('link', { name: /cookie policy/i });
      expect(cookieLink).toBeInTheDocument();
    });

    it('opens footer contact modal when Contact button is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<About />);

      const footer = document.querySelector('footer');
      const footerScope = within(footer!);
      await user.click(footerScope.getByRole('button', { name: /contact/i }));

      // Footer contact modal uses default subtitle (no custom subtitle passed)
      await waitFor(() => {
        expect(
          screen.getByText(/have questions\? we'd love to hear from you/i),
        ).toBeInTheDocument();
      });
    });
  });

  // ─── Page Structure ───────────────────────────────────────────

  describe('Page structure', () => {
    it('renders the header, main content, and footer', () => {
      renderWithProviders(<About />);
      expect(document.querySelector('header')).not.toBeNull();
      expect(document.querySelector('main')).not.toBeNull();
      expect(document.querySelector('footer')).not.toBeNull();
    });

    it('renders all three content sections (Mission, Team, Hiring)', async () => {
      renderWithProviders(<About />);
      expect(screen.getByRole('heading', { name: /mission/i, level: 1 })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: /team/i, level: 2 })).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /hiring/i, level: 2 })).toBeInTheDocument();
      });
    });
  });

  // ─── Waitlist CTA visibility by auth state ────────────────────
  //
  // The header + footer "Join Waitlist" CTAs must disappear once a user is
  // signed in with a real (non-anonymous) account, but must stay visible for
  // logged-out AND anonymous-bootstrap visitors (every landing visitor gets an
  // anonymous session — they are not "logged in").

  describe('Waitlist CTA auth-gating', () => {
    const SESSION_KEY = 'rose-session';
    const USER_CACHE_KEY = 'app-user';

    function seedSession(anonymous: boolean): void {
      const session = {
        access_token: 'test-token-abc',
        refresh_token: 'test-refresh-xyz',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
        user: {
          id: 'test-user-001',
          phone: '+19729777432',
          is_anonymous: anonymous,
          aud: 'authenticated',
          role: 'authenticated',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          app_metadata: anonymous
            ? { provider: 'anonymous', providers: ['anonymous'] }
            : { provider: 'phone', providers: ['phone'] },
          user_metadata: {},
        },
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      localStorage.setItem(USER_CACHE_KEY, JSON.stringify(session.user));
    }

    afterEach(() => {
      localStorage.clear();
    });

    it('hides the header + footer Join Waitlist CTAs when signed in with a real account', async () => {
      seedSession(false);
      renderWithProviders(<About />);

      await waitFor(() => {
        const header = document.getElementById('site-header')!;
        expect(within(header).queryByRole('button', { name: /join waitlist/i })).toBeNull();
      });

      expect(document.querySelector('footer')).toBeNull();
    });

    it('keeps the Join Waitlist CTAs visible for an anonymous (not-logged-in) session', async () => {
      seedSession(true);
      renderWithProviders(<About />);

      // Let the passive auth effect settle, then confirm the CTAs remain.
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /mission/i, level: 1 })).toBeInTheDocument();
      });

      const header = document.getElementById('site-header')!;
      expect(
        within(header).getAllByRole('button', { name: /join waitlist/i }).length,
      ).toBeGreaterThanOrEqual(1);
      const footer = document.querySelector('footer')!;
      expect(within(footer).getByRole('button', { name: /join waitlist/i })).toBeInTheDocument();
    });
  });
});
