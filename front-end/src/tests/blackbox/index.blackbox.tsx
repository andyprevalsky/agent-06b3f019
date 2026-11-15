import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { http, HttpResponse } from 'msw';
import Index from '@/pages/Index';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROSE_APP_DESCRIPTION } from '@/lib/googlePublicCopy';

describe('Index (landing) page', () => {
  beforeEach(() => {
    clearCaptures();
    // Clear stored session so auth hook creates a fresh anonymous session
    window.localStorage.removeItem('rose-session');
    window.localStorage.removeItem('app-user');
    // Stub scrollIntoView (not implemented in jsdom)
    Element.prototype.scrollIntoView = () => {};
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('Rendering', () => {
    it('renders the hero section with typewriter text', async () => {
      renderWithProviders(<Index />);

      await waitFor(
        () => {
          const heroText = document.querySelector('.hero-typed-text');
          expect(heroText).toBeTruthy();
          expect(heroText!.textContent).toMatch(/Hi! I'm Rose/);
        },
        { timeout: 5000 },
      );
    });

    it('renders the features section with feature titles', () => {
      renderWithProviders(<Index />);

      // "Features" appears in both header nav and section heading
      const featuresElements = screen.getAllByText('Features');
      expect(featuresElements.length).toBeGreaterThanOrEqual(2);

      // Individual feature titles appear (desktop + mobile layouts)
      expect(screen.getAllByText('Fully Customizable').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Seamless Conversations').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Agent Enabled').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Rose Grows With You').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Privacy First').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the waitlist section heading', () => {
      renderWithProviders(<Index />);

      // "Join the Waitlist" appears in nav, features CTA, and section heading
      const elements = screen.getAllByText('Join the Waitlist');
      expect(elements.length).toBeGreaterThanOrEqual(1);

      // The section heading is a span.gradient-text inside an h2
      const h2Heading = elements.find((el) => el.closest('h2') !== null);
      expect(h2Heading).toBeTruthy();
    });

    it('renders header with Rose branding and nav links', () => {
      renderWithProviders(<Index />);

      const header = document.getElementById('site-header')!;
      expect(header).toBeTruthy();
      expect(within(header).getByText('Rose')).toBeInTheDocument();

      // Desktop nav links
      expect(within(header).getByText('Features')).toBeInTheDocument();
      expect(within(header).getByText('Research')).toBeInTheDocument();
      expect(within(header).queryByText('About')).not.toBeInTheDocument();
    });

    it('renders footer with legal links and copyright', () => {
      renderWithProviders(<Index />);

      expect(screen.getByText('Rose Labs')).toBeInTheDocument();
      expect(screen.getByText(/2026 Rose Labs\. All rights reserved/)).toBeInTheDocument();
      expect(screen.getByText('Privacy Policy')).toBeInTheDocument();
      expect(screen.getByText('Terms of Service')).toBeInTheDocument();
      expect(screen.getByText('Cookie Policy')).toBeInTheDocument();
      expect(screen.getByText(ROSE_APP_DESCRIPTION)).toBeInTheDocument();
    });

    it('ships public Privacy and Terms links (and no About page link) in static HTML', () => {
      const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
      expect(html).toMatch(/<footer class="rose-static-links">/);
      expect(html).not.toContain('href="/about"');
      expect(html).toContain('<a href="/terms">Terms</a>');
      expect(html).toContain('<a href="/privacy">Privacy</a>');
      expect(html).not.toMatch(/rose-static-links[^}]*display:\s*none/);
    });

    it('ships the Agentic Supercomputer description in static link-preview metadata', () => {
      const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const meta = (selector: string) =>
        doc.querySelector(selector)?.getAttribute('content') ?? null;
      const description =
        'Rose is the world’s first Agentic Supercomputer, capable of spawning hundreds of thousands of agents to complete complex real-world tasks over months.';
      expect(meta('meta[name="description"]')).toBe(description);
      expect(meta('meta[property="og:description"]')).toBe(description);
      expect(meta('meta[property="og:title"]')).toBe('Rose | Agentic Supercomputer by Rose Labs');
    });

    it('renders the Powered By ticker with provider logos', () => {
      renderWithProviders(<Index />);

      expect(screen.getByText('Powered by')).toBeInTheDocument();

      // Provider logos (appear twice in ticker for seamless scroll)
      expect(screen.getAllByAltText('OpenAI').length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByAltText('Anthropic').length).toBeGreaterThanOrEqual(2);
    });

    it('renders waitlist product variants (Midnight Black, Pearl White, Custom)', () => {
      renderWithProviders(<Index />);

      expect(screen.getAllByText('Midnight Black').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Pearl White').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Custom').length).toBeGreaterThanOrEqual(1);
    });

    it('renders the scroll-to-features arrow button', () => {
      renderWithProviders(<Index />);

      expect(screen.getByRole('button', { name: 'Scroll to features' })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // User interaction
  // ---------------------------------------------------------------------------

  describe('User interaction', () => {
    it('expands waitlist form, fills name/email, submits, and captures POST to waitlist endpoint', async () => {
      const user = userEvent.setup();

      server.use(
        http.post('http://localhost:3001/api/waitlist', () => {
          return HttpResponse.json({ success: true, message: 'Joined waitlist!' });
        }),
      );

      renderWithProviders(<Index />);

      // Wait for auth to settle so the page is fully rendered
      await waitFor(() => {
        expect(
          screen.getAllByRole('button', { name: 'Join Waitlist' }).length,
        ).toBeGreaterThanOrEqual(3);
      });

      // Target the Custom variant's "Join Waitlist" button via H3 heading
      const customHeading = screen.getAllByText('Custom').find((el) => el.tagName === 'H3')!;
      expect(customHeading).toBeTruthy();
      const customWrapper = customHeading.closest('.w-full')!;
      expect(customWrapper).toBeTruthy();

      const joinButton = within(customWrapper as HTMLElement).getByRole('button', {
        name: 'Join Waitlist',
      });
      await user.click(joinButton);

      // Form fields should now be visible within the custom wrapper
      const nameInput = await within(customWrapper as HTMLElement).findByPlaceholderText(
        'John Doe',
      );
      const emailInput = await within(customWrapper as HTMLElement).findByPlaceholderText(
        'john@example.com',
      );

      await user.type(nameInput, 'Test User');
      await user.type(emailInput, 'test@example.com');

      // Find the submit button (type=submit) within the custom wrapper
      const submitButton = within(customWrapper as HTMLElement).getByRole('button', {
        name: 'Join Waitlist',
      });
      await user.click(submitButton);

      // Wait for the API call to be captured
      await waitFor(() => {
        const waitlistCalls = capturedRequests.filter(
          (r) => r.url.includes('/api/waitlist') && r.method === 'POST',
        );
        expect(waitlistCalls.length).toBeGreaterThanOrEqual(1);
        const body = waitlistCalls[0].body as Record<string, unknown>;
        expect(body.name).toBe('Test User');
        expect(body.email).toBe('test@example.com');
        expect(body.variant).toBe('custom');
      });

      // Success state should show
      await waitFor(() => {
        expect(screen.getByText("You're On The Waitlist")).toBeInTheDocument();
      });
    });

    it('shows email validation error and does NOT make an API call for invalid email', async () => {
      const user = userEvent.setup();

      server.use(
        http.post('http://localhost:3001/api/waitlist', () => {
          return HttpResponse.json({ success: true, message: 'Joined waitlist!' });
        }),
      );

      renderWithProviders(<Index />);

      // Wait for auth to settle
      await waitFor(() => {
        expect(
          screen.getAllByRole('button', { name: 'Join Waitlist' }).length,
        ).toBeGreaterThanOrEqual(3);
      });

      // Target the Custom variant
      const customHeading = screen.getAllByText('Custom').find((el) => el.tagName === 'H3')!;
      const customWrapper = customHeading.closest('.w-full')!;

      const joinButton = within(customWrapper as HTMLElement).getByRole('button', {
        name: 'Join Waitlist',
      });
      await user.click(joinButton);

      const nameInput = await within(customWrapper as HTMLElement).findByPlaceholderText(
        'John Doe',
      );
      const emailInput = await within(customWrapper as HTMLElement).findByPlaceholderText(
        'john@example.com',
      );

      await user.type(nameInput, 'Test User');
      // Use "user@bad" which passes HTML5 email validation but fails the custom
      // regex (requires a dot after the @: /^[^\s@]+@[^\s@]+\.[^\s@]+$/)
      await user.type(emailInput, 'user@bad');

      // Submit
      const submitButton = within(customWrapper as HTMLElement).getByRole('button', {
        name: 'Join Waitlist',
      });
      await user.click(submitButton);

      // Error message should appear
      await waitFor(() => {
        expect(screen.getByText('Please enter a valid email address')).toBeInTheDocument();
      });

      // No waitlist API call should have been made
      const waitlistCalls = capturedRequests.filter(
        (r) => r.url.includes('/api/waitlist') && r.method === 'POST',
      );
      expect(waitlistCalls).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // API boundary capture
  // ---------------------------------------------------------------------------

  describe('API boundary capture', () => {
    it('creates an anonymous session on page load when no session exists', async () => {
      renderWithProviders(<Index />);

      await waitFor(
        () => {
          const anonCalls = capturedRequests.filter(
            (r) => r.url.includes('/api/auth/anonymous') && r.method === 'POST',
          );
          expect(anonCalls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
    });
  });
});
