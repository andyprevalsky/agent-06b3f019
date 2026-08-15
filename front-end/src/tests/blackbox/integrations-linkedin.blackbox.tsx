/**
 * Blackbox tests for the LinkedIn export flow on the Integrations page.
 *
 * Split from integrations.blackbox.tsx to keep both files under the
 * 600-line max-lines budget.
 */
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

const API_BASE = 'http://localhost:3001/api';

/**
 * Sets up a fully-signed-in session in localStorage so useAuth resolves
 * as authenticated with isFullySignedIn = true.
 */
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

/**
 * Default integrations endpoint handler returning empty list.
 */
function integrationsHandler(integrations: unknown[] = []) {
  return http.get(`${API_BASE}/integrations`, () => {
    return HttpResponse.json({ integrations });
  });
}
describe('Integrations page - LinkedIn export flow', () => {
  beforeEach(() => {
    mockSession();
    server.use(integrationsHandler());
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('LinkedIn export flow', () => {
    function macHandlers(): IntegrationHandlers {
      return {
        browserCookies: {
          isAvailable: true,
          getInstalledBrowsers: vi.fn(async () => []),
          syncBrowser: vi.fn(async () => {}),
          syncBrowserPasswords: vi.fn(async () => ({ success: true })),
          storeAtlasPassword: vi.fn(async () => ({ success: true })),
          openKeychainAccess: vi.fn(async () => ({ success: true })),
        },
      };
    }

    async function expandSocialsAndGetLinkedInButton(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() => {
        expect(screen.getByText('Socials')).toBeInTheDocument();
      });
      const socialsSection = screen.getByText('Socials').closest('.rounded-lg')!;
      await user.click(within(socialsSection).getAllByRole('button')[0]);
      await waitFor(() => {
        expect(screen.getByText('LinkedIn')).toBeInTheDocument();
      });
      return screen.getByRole('button', { name: 'Connect LinkedIn' });
    }

    it('spawns one export agent, toasts, and blocks re-export on the second click', async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_BASE}/agents`, () => {
          return HttpResponse.json({ id: 'agent-linkedin' });
        }),
      );

      renderWithProviders(
        <IntegrationHandlersProvider handlers={macHandlers()}>
          <Integrations />
          <Toaster />
        </IntegrationHandlersProvider>,
      );

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      clearCaptures();

      await user.click(linkedInButton);

      // Toast confirms the agent was spawned.
      await waitFor(() => {
        expect(
          screen.getByText('An agent was spawned to connect your LinkedIn data.'),
        ).toBeInTheDocument();
      });

      // Exactly one agent was created.
      const agentCalls = () =>
        capturedRequests.filter((r) => r.url.endsWith('/api/agents') && r.method === 'POST');
      expect(agentCalls().length).toBe(1);

      // Button is now disabled -- re-export is blocked.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect LinkedIn' })).toBeDisabled();
      });

      // A second click does not spawn another agent.
      await user.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
      expect(agentCalls().length).toBe(1);
    });

    it('renders the LinkedIn connect affordance as a plus button', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <IntegrationHandlersProvider handlers={macHandlers()}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      // lucide-react renders the Plus icon with a `lucide-plus` class.
      expect(linkedInButton.querySelector('.lucide-plus')).toBeInTheDocument();
    });

    it('spawns only one agent for concurrent sync calls that overlap in flight', async () => {
      // The disabled button hides this at the UI level, but the hook contract
      // must hold on its own: `linkedinSyncStarted` is React state and only
      // flips after the create call resolves, so two overlapping calls would
      // both pass a state-only guard and spawn duplicate export agents.
      let releaseCreate: () => void = () => {};
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      server.use(
        http.post(`${API_BASE}/agents`, async () => {
          await createGate;
          return HttpResponse.json({ id: 'agent-linkedin' });
        }),
      );

      const { result } = renderHook(() => useMessagesSync({} as never, async () => {}));
      clearCaptures();

      await act(async () => {
        const first = result.current.handleLinkedInSync();
        const second = result.current.handleLinkedInSync();
        releaseCreate();
        await Promise.all([first, second]);
      });

      expect(result.current.linkedinSyncStarted).toBe(true);
      const agentCalls = capturedRequests.filter(
        (r) => r.url.endsWith('/api/agents') && r.method === 'POST',
      );
      expect(agentCalls.length).toBe(1);
    });

    it('lights the LinkedIn row itself as connected once the export agent is spawned', async () => {
      const user = userEvent.setup();

      server.use(
        http.post(`${API_BASE}/agents`, () => {
          return HttpResponse.json({ id: 'agent-linkedin' });
        }),
      );

      renderWithProviders(
        <IntegrationHandlersProvider handlers={macHandlers()}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      const linkedInRow = screen
        .getByText('LinkedIn')
        .closest('.flex.items-center.justify-between')!;

      // Before connecting: no status sub-label and no rose glow on the row icon.
      expect(within(linkedInRow).queryByText(/Connecting your data/)).not.toBeInTheDocument();
      const glowOf = () =>
        Array.from(linkedInRow.querySelectorAll('span[aria-hidden="true"]')).find((el) =>
          (el as HTMLElement).style.backgroundImage.includes('254, 117, 3'),
        );
      expect(glowOf()).toBeUndefined();

      await user.click(linkedInButton);

      // After connecting: the row (not just the section header) reads as connected.
      await waitFor(() => {
        expect(within(linkedInRow).getByText(/Connecting your data/)).toBeInTheDocument();
      });
      expect(glowOf()).toBeDefined();
    });
  });
});
