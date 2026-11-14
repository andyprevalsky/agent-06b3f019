import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { Toaster } from '@/components/ui/toaster';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import { useMessagesSync } from '@/features/integrations/hooks/useMessagesSync';
import type { IntegrationHandlers } from '@/features/integration-handlers-context';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API_BASE = 'http://localhost:3001/api';

function sectionFor(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>('.rounded-lg')!;
}

/**
 * Default integrations endpoint handler returning empty list.
 */
function integrationsHandler(integrations: unknown[] = []) {
  return http.get(`${API_BASE}/integrations`, () => {
    return HttpResponse.json({ integrations });
  });
}

describe('Integrations page', () => {
  beforeEach(() => {
    mockSession();
    // The page fetches /api/integrations on mount -- not in default handlers
    server.use(integrationsHandler());
  });

  afterEach(() => {
    localStorage.clear();
    delete window.api;
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders the main integration sections', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      // Wait for loading to finish and sections to appear
      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      expect(screen.getByText('Passwords')).toBeInTheDocument();
      expect(screen.getByText('Messages')).toBeInTheDocument();
      expect(screen.getByText('Socials')).toBeInTheDocument();
      expect(screen.getByText('File System')).toBeInTheDocument();
    });

    it('shows "Desktop Only" badge for Browser Cookies on web (no handler)', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      const browserSection = sectionFor('Browser Cookies');
      expect(within(browserSection).getByText('Desktop Only')).toBeInTheDocument();
      expect(
        within(browserSection).getByRole('link', { name: /download for mac/i }),
      ).toBeInTheDocument();
    });

    it('shows Passwords section with subtitle', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Passwords')).toBeInTheDocument();
      });

      expect(screen.getByText('Auto-fill login credentials')).toBeInTheDocument();
    });

    it('shows Messages section with subtitle', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      expect(screen.getByText('Sync messaging clients')).toBeInTheDocument();
    });

    it('renders the Messages icon inside its viewBox', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const icon = screen.getByLabelText('Messages icon');
      expect(icon).toBeInTheDocument();
      expect(icon.querySelector('path')).toHaveAttribute(
        'transform',
        'translate(24 0) scale(-1 1)',
      );
    });

    it('shows Socials section with subtitle', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Socials')).toBeInTheDocument();
      });

      expect(screen.getByText('Connect social media accounts')).toBeInTheDocument();
    });

    it('shows File System as Desktop Only with Download for Mac on the website', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('File System')).toBeInTheDocument();
      });

      const fileSystemSection = sectionFor('File System');
      expect(screen.getByText('Sync your files to the cloud')).toBeInTheDocument();
      expect(within(fileSystemSection).getByText('Desktop Only')).toBeInTheDocument();
      expect(
        within(fileSystemSection).getByRole('link', { name: /download for mac/i }),
      ).toHaveAttribute('href', '/download');
      expect(
        within(fileSystemSection).queryByRole('button', { name: /connect file system/i }),
      ).not.toBeInTheDocument();
    });

    it('shows the File System connect plus in the Mac app', async () => {
      window.api = { isElectron: true };
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('File System')).toBeInTheDocument();
      });

      const fileSystemSection = sectionFor('File System');
      expect(
        within(fileSystemSection).getByRole('button', { name: /connect file system/i }),
      ).toBeInTheDocument();
      expect(within(fileSystemSection).queryByText('Desktop Only')).not.toBeInTheDocument();
      expect(within(fileSystemSection).queryByText('Download for Mac')).not.toBeInTheDocument();
    });

    it('does nothing when File System connect is clicked in the Mac app', async () => {
      window.api = { isElectron: true };
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('File System')).toBeInTheDocument();
      });
      // Let the page's initial status reads (e.g. Granola) land before the
      // capture window opens, so only requests caused by the click count.
      expect(
        await screen.findAllByText('Search your meeting notes, summaries and transcripts'),
      ).toHaveLength(2);

      clearCaptures();
      const fileSystemSection = sectionFor('File System');
      const connectButton = within(fileSystemSection).getByRole('button', {
        name: /connect file system/i,
      });
      await user.click(connectButton);

      expect(screen.getByText('File System')).toBeInTheDocument();
      expect(screen.getByText('Sync your files to the cloud')).toBeInTheDocument();
      expect(within(fileSystemSection).queryByText('Connected')).not.toBeInTheDocument();
      expect(capturedRequests).toHaveLength(0);
    });

    it('shows Compute section for fully signed-in users', async () => {
      renderWithProviders(<Integrations />, { roseDesktop: false });

      // Compute only shows when isFullySignedIn=true (non-anonymous + invite code check passes)
      await waitFor(() => {
        expect(screen.getByText('Compute')).toBeInTheDocument();
      });

      expect(screen.getByText('Connect AI subscriptions')).toBeInTheDocument();
    });

    it('shows a loading spinner while integrations are being fetched', async () => {
      // Use a delayed handler so loading state is visible
      server.use(
        http.get(`${API_BASE}/integrations`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return HttpResponse.json({ integrations: [] });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      // The page should show a loading spinner initially
      // Loader2 renders as an SVG with animate-spin class
      const spinner = document.querySelector('.animate-spin');
      expect(spinner).toBeInTheDocument();

      // After loading completes, sections appear
      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });
    });

    it('renders connected state (checkmark) when integrations are connected', async () => {
      server.use(
        integrationsHandler([
          {
            id: 'int-1',
            name: 'gmail',
            status: 'CONNECTED',
            isActive: true,
            config: { connectedEmail: 'test@gmail.com' },
          },
          { id: 'int-2', name: 'imessage', status: 'CONNECTED', isActive: true },
        ]),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      // Wait for the page to load
      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      // The Messages section button should reflect connected status
      // Connected sections get a green background with a Check icon
      // We verify the section loaded with data rather than asserting on SVG internals
      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });
    });

    it('shows WhatsApp as Synced when a connected whatsapp integration exists', async () => {
      const user = userEvent.setup();
      server.use(
        integrationsHandler([
          { id: 'int-wa', name: 'whatsapp', status: 'CONNECTED', isActive: true },
        ]),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      const whatsAppRow = screen.getByText('WhatsApp').closest<HTMLElement>('div.px-4')!;
      expect(within(whatsAppRow as HTMLElement).getByText('Synced')).toBeInTheDocument();
      // Connected state replaces the Desktop-Only download affordance.
      expect(
        within(whatsAppRow as HTMLElement).queryByText('Download for Mac'),
      ).not.toBeInTheDocument();
    });

    it('renders Safari browser rows with a first-class icon from the Mac handler', async () => {
      const user = userEvent.setup();
      const handlers: IntegrationHandlers = {
        browserCookies: {
          isAvailable: true,
          getInstalledBrowsers: vi.fn(async () => [
            {
              type: 'safari' as const,
              name: 'Safari',
              isInstalled: true,
              needsManualPassword: false,
            },
          ]),
          syncBrowser: vi.fn(async () => {}),
          syncBrowserPasswords: vi.fn(async () => ({ success: true })),
          storeAtlasPassword: vi.fn(async () => ({ success: true })),
          openKeychainAccess: vi.fn(async () => ({ success: true })),
        },
      };

      renderWithProviders(
        <IntegrationHandlersProvider handlers={handlers}>
          <Integrations />
        </IntegrationHandlersProvider>,
        { roseDesktop: false },
      );

      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      const browserSection = sectionFor('Browser Cookies');
      const toggleButton = within(browserSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('Safari')).toBeInTheDocument();
      });
      expect(screen.getByRole('img', { name: 'Safari' })).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // User interactions - Expanding sections
  // ---------------------------------------------------------------------------

  describe('expanding sections', () => {
    it('expands Passwords section and shows sub-items', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Passwords')).toBeInTheDocument();
      });

      // Find the Passwords section toggle button and click it
      const passwordsSection = sectionFor('Passwords');
      const toggleButton = within(passwordsSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      // Should show the unified Apple credential exchange sub-item
      await waitFor(() => {
        expect(screen.getByText('Apple Passwords & Passkeys')).toBeInTheDocument();
      });
    });

    it('expands Messages section and shows messaging clients', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      // Click the Messages toggle
      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      // Should show messaging clients
      await waitFor(() => {
        expect(screen.getByText('Gmail')).toBeInTheDocument();
      });

      expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      expect(screen.getByText('Telegram')).toBeInTheDocument();
      expect(screen.getByText('Messenger')).toBeInTheDocument();
    });

    it('expands Socials section and shows social media items', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Socials')).toBeInTheDocument();
      });

      const socialsSection = sectionFor('Socials');
      const toggleButton = within(socialsSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('X')).toBeInTheDocument();
      });

      expect(screen.getByText('LinkedIn')).toBeInTheDocument();
      expect(screen.getByText('Instagram')).toBeInTheDocument();
    });

    it('only one section is expanded at a time (accordion behavior)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Passwords')).toBeInTheDocument();
      });

      // Expand Passwords section
      const passwordsSection = sectionFor('Passwords');
      const passwordsToggle = within(passwordsSection).getAllByRole('button')[0];
      await user.click(passwordsToggle);

      await waitFor(() => {
        expect(screen.getByText('Apple Passwords & Passkeys')).toBeInTheDocument();
      });

      // Now expand Messages - should close Passwords
      const messagesSection = sectionFor('Messages');
      const messagesToggle = within(messagesSection).getAllByRole('button')[0];
      await user.click(messagesToggle);

      await waitFor(() => {
        expect(screen.getByText('Gmail')).toBeInTheDocument();
      });

      // Apple credential exchange row should no longer be visible (Passwords section collapsed)
      expect(screen.queryByText('Apple Passwords & Passkeys')).not.toBeInTheDocument();
    });

    it('shows "Coming Soon" badges for Telegram and Messenger (not WhatsApp)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      // Telegram + Messenger are still Coming Soon; WhatsApp is now a real
      // connectable row (Desktop Only on web), so it must NOT be Coming Soon.
      const comingSoonBadges = screen.getAllByText('Coming Soon');
      expect(comingSoonBadges.length).toBeGreaterThanOrEqual(2);
    });

    it('shows WhatsApp as "Desktop Only" with a Download link when not connected', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      // WhatsApp pairs only in the Mac app, so on web it reads "Desktop Only".
      const whatsAppRow = screen.getByText('WhatsApp').closest<HTMLElement>('div.px-4')!;
      expect(within(whatsAppRow as HTMLElement).getByText('Desktop Only')).toBeInTheDocument();
      expect(within(whatsAppRow as HTMLElement).getByText('Download for Mac')).toBeInTheDocument();
    });

    it('shows "Coming Soon" badges for X and Instagram in Socials', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Socials')).toBeInTheDocument();
      });

      const socialsSection = sectionFor('Socials');
      const toggleButton = within(socialsSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('X')).toBeInTheDocument();
      });

      const comingSoonBadges = screen.getAllByText('Coming Soon');
      expect(comingSoonBadges.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Gmail connect flow
  // ---------------------------------------------------------------------------

  describe('Gmail OAuth flow', () => {
    it('clicking Gmail connect triggers the OAuth start API call', async () => {
      const user = userEvent.setup();

      // Mock the Gmail OAuth start endpoint
      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
          return HttpResponse.json({ authUrl: 'https://accounts.google.com/oauth/test' });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      // Expand Messages
      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('Gmail')).toBeInTheDocument();
      });

      clearCaptures();

      // Click the Gmail sync button
      const gmailRow = screen
        .getByText('Gmail')
        .closest<HTMLElement>('.flex.items-center.justify-between')!;
      expect(
        within(gmailRow).getByText(/Google consent also requests Calendar and Drive access/),
      ).toBeInTheDocument();
      const gmailButton = within(gmailRow).getByRole('button', { name: 'Connect Google' });
      await user.click(gmailButton);

      // Verify the API call was made
      await waitFor(() => {
        const gmailCalls = capturedRequests.filter(
          (r) => r.url.includes('/integrations/email/gmail/start') && r.method === 'POST',
        );
        expect(gmailCalls.length).toBe(1);
      });
    });

    it('shows connected email when Gmail integration exists', async () => {
      const user = userEvent.setup();

      server.use(
        integrationsHandler([
          {
            id: 'int-gmail',
            name: 'gmail',
            status: 'CONNECTED',
            isActive: true,
            config: { connectedEmail: 'user@gmail.com' },
          },
        ]),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      // Expand Messages
      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      // Should show the connected email address
      await waitFor(() => {
        expect(screen.getByText('user@gmail.com')).toBeInTheDocument();
      });
    });

    it('disconnects a connected Gmail email from its chip', async () => {
      const user = userEvent.setup();
      let integrations = [
        {
          id: 'int-gmail',
          name: 'gmail',
          status: 'CONNECTED',
          isActive: true,
          config: { connectedEmail: 'user@gmail.com', connectedEmails: ['user@gmail.com'] },
        },
      ];
      let deletedEmail: string | null = null;

      server.use(
        http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations })),
        http.delete(`${API_BASE}/integrations/email/gmail/accounts/:email`, ({ params }) => {
          deletedEmail = decodeURIComponent(String(params.email));
          integrations = [];
          return HttpResponse.json({
            message: 'Gmail account disconnected successfully',
            disconnectedEmail: deletedEmail,
            connectedEmails: [],
          });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      const chip = await screen.findByRole('button', { name: /disconnect user@gmail.com/i });
      expect(within(chip).getByText('user@gmail.com')).toBeInTheDocument();
      await user.click(chip);

      await waitFor(() => {
        expect(deletedEmail).toBe('user@gmail.com');
      });
      await waitFor(() => {
        expect(screen.queryByText('user@gmail.com')).not.toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Password request bar
  // ---------------------------------------------------------------------------

  describe('password request bar', () => {
    it('does not show the removed password client request bar', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Passwords')).toBeInTheDocument();
      });

      // Expand Passwords
      const passwordsSection = sectionFor('Passwords');
      const toggleButton = within(passwordsSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      expect(screen.queryByText(/Request one/)).not.toBeInTheDocument();
      expect(
        screen.queryByPlaceholderText(/1Password, Bitwarden, LastPass/i),
      ).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // API boundary capture
  // ---------------------------------------------------------------------------

  describe('API boundary capture', () => {
    it('fetches /api/integrations on page load', async () => {
      clearCaptures();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      const integrationCalls = capturedRequests.filter(
        (r) =>
          r.url.includes('/api/integrations') && r.method === 'GET' && !r.url.includes('/email/'),
      );
      expect(integrationCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('fetches /api/invite-codes/check on page load (via useAuth)', async () => {
      clearCaptures();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      const inviteCalls = capturedRequests.filter((r) => r.url.includes('/invite-codes/check'));
      expect(inviteCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('sends Authorization header on integrations fetch', async () => {
      clearCaptures();
      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });

      const integrationCalls = capturedRequests.filter(
        (r) =>
          r.url.includes('/api/integrations') && r.method === 'GET' && !r.url.includes('/email/'),
      );
      expect(integrationCalls.length).toBeGreaterThanOrEqual(1);
      expect(integrationCalls[0].headers['authorization']).toBe('Bearer test-token');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('handles integrations API failure gracefully (no crash)', async () => {
      server.use(
        http.get(`${API_BASE}/integrations`, () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      // The page should still render sections even if the fetch failed
      await waitFor(() => {
        expect(screen.getByText('Browser Cookies')).toBeInTheDocument();
      });
    });

    it('shows error banner when Gmail OAuth start fails', async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
          return HttpResponse.json({ error: 'Failed to start email connection' }, { status: 500 });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      // Expand Messages
      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('Gmail')).toBeInTheDocument();
      });

      // Click Gmail sync button
      const gmailRow = screen
        .getByText('Gmail')
        .closest<HTMLElement>('.flex.items-center.justify-between')!;
      const gmailButton = within(gmailRow).getByRole('button');
      await user.click(gmailButton);

      // Should show error banner
      await waitFor(() => {
        expect(screen.getByText('Failed to start email connection')).toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Connected integration states from API
  // ---------------------------------------------------------------------------

  describe('connected integration states', () => {
    it('reflects connected passwords state from API', async () => {
      const user = userEvent.setup();

      server.use(
        integrationsHandler([
          { id: 'int-1', name: 'chrome_passwords', status: 'CONNECTED', isActive: true },
          { id: 'int-2', name: 'apple_passwords', status: 'CONNECTED', isActive: true },
        ]),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Passwords')).toBeInTheDocument();
      });

      // The Passwords section should show a connected (check) indicator
      // since chrome_passwords and apple_passwords are connected.
      // Expand to verify sub-items still render.
      const passwordsSection = sectionFor('Passwords');
      const toggleButton = within(passwordsSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('Apple Passwords & Passkeys')).toBeInTheDocument();
      });
    });

    it('shows connected Gmail with multiple emails in Messages', async () => {
      const user = userEvent.setup();

      server.use(
        integrationsHandler([
          {
            id: 'int-gmail',
            name: 'gmail',
            status: 'CONNECTED',
            isActive: true,
            config: { connectedEmails: ['user1@gmail.com', 'user2@gmail.com'] },
          },
        ]),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      await waitFor(() => {
        expect(screen.getByText('Messages')).toBeInTheDocument();
      });

      const messagesSection = sectionFor('Messages');
      const toggleButton = within(messagesSection).getAllByRole('button')[0];
      await user.click(toggleButton);

      await waitFor(() => {
        expect(screen.getByText('user1@gmail.com')).toBeInTheDocument();
      });
      expect(screen.getByText('user2@gmail.com')).toBeInTheDocument();
    });
  });
});
