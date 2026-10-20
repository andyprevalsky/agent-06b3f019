/**
 * Blackbox tests for the LinkedIn export flow on the Integrations page.
 *
 * Split from integrations.blackbox.tsx to keep both files under the
 * 600-line max-lines budget.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { Toaster } from '@/components/ui/toaster';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import {
  LINKEDIN_SYNC_REFRESH_MS,
  useMessagesSync,
} from '@/features/integrations/hooks/useMessagesSync';
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

function linkedinRow(status: string, syncAgentId = 'agent-linkedin') {
  return {
    id: 'integration-linkedin',
    name: 'linkedin',
    type: 'DATA_SOURCE',
    status,
    isActive: false,
    config: { syncAgentId },
  };
}

/**
 * A stateful backend: POST /agents creates the agent, POST
 * /integrations/linkedin/sync records it, and GET /integrations then reports
 * the LinkedIn row SYNCING — the same order the real backend enforces.
 */
function linkedinBackend(createGate?: Promise<void>) {
  const state = { agents: [] as string[], linkedin: null as unknown };
  server.use(
    http.post(`${API_BASE}/agents`, async () => {
      if (createGate) await createGate;
      const agentId = `agent-linkedin-${state.agents.length + 1}`;
      state.agents.push(agentId);
      return HttpResponse.json({ agent_id: agentId, status: 'ACTIVE' });
    }),
    http.post(`${API_BASE}/integrations/linkedin/sync`, async ({ request }) => {
      const body = (await request.json()) as { agent_id: string };
      if (!state.agents.includes(body.agent_id)) {
        return HttpResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      state.linkedin = linkedinRow('SYNCING', body.agent_id);
      return HttpResponse.json({ status: 'SYNCING', agent_id: body.agent_id });
    }),
    http.get(`${API_BASE}/integrations`, () =>
      HttpResponse.json({ integrations: state.linkedin ? [state.linkedin] : [] }),
    ),
  );
  return state;
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

    function renderIntegrations() {
      return renderWithProviders(
        <IntegrationHandlersProvider handlers={macHandlers()}>
          <Integrations />
          <Toaster />
        </IntegrationHandlersProvider>,
      );
    }

    async function expandSocialsAndGetLinkedInButton(user: ReturnType<typeof userEvent.setup>) {
      await waitFor(() => {
        expect(screen.getByText('Socials')).toBeInTheDocument();
      });
      const socialsSection = screen.getByText('Socials').closest<HTMLElement>('.rounded-lg')!;
      await user.click(within(socialsSection).getAllByRole('button')[0]);
      await waitFor(() => {
        expect(screen.getByText('LinkedIn')).toBeInTheDocument();
      });
      return screen.getByRole('button', { name: 'Connect LinkedIn' });
    }

    function linkedInRowElement() {
      return screen
        .getByText('LinkedIn')
        .closest<HTMLElement>('.flex.items-center.justify-between')!;
    }

    const agentCalls = () =>
      capturedRequests.filter((r) => r.url.endsWith('/api/agents') && r.method === 'POST');

    it('spawns one export agent, toasts, and blocks re-export on the second click', async () => {
      const user = userEvent.setup();
      linkedinBackend();
      renderIntegrations();

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      clearCaptures();

      await user.click(linkedInButton);

      await waitFor(() => {
        expect(
          screen.getByText('An agent was spawned to connect your LinkedIn data.'),
        ).toBeInTheDocument();
      });
      expect(agentCalls().length).toBe(1);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Connect LinkedIn' })).toBeDisabled();
      });

      await user.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
      expect(agentCalls().length).toBe(1);
    });

    it('spawns a cloud agent directly (no chat router) and records it as the LinkedIn sync', async () => {
      // The old flow posted `depth: 1` and a hard-coded MAC_APP source from a
      // hand-rolled fetch; the export agent must be a normal agent instead.
      const user = userEvent.setup();
      const backend = linkedinBackend();
      renderIntegrations();

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      clearCaptures();
      await user.click(linkedInButton);

      await waitFor(() => {
        expect(
          capturedRequests.some(
            (r) => r.url.endsWith('/api/integrations/linkedin/sync') && r.method === 'POST',
          ),
        ).toBe(true);
      });
      const create = agentCalls()[0];
      const createBody = create.body as Record<string, unknown>;
      expect(createBody.depth).toBeUndefined();
      expect(createBody.price_limit_cents).toBeUndefined();
      expect(createBody.source).toBe('WEB');
      // Directly a cloud agent: the chat router never sees this request.
      expect(createBody.start_phase).toBe('execute');
      expect(String(createBody.goal)).toMatch(/^Download my LinkedIn data export/);
      const record = capturedRequests.find((r) =>
        r.url.endsWith('/api/integrations/linkedin/sync'),
      )!;
      expect(record.body).toEqual({ agent_id: backend.agents[0] });
    });

    it('keeps showing Connecting after a refresh while the export agent runs', async () => {
      // Reported bug: "Connecting…" lived only in React state, so a reload of
      // the page dropped it while the export agent was still running.
      const user = userEvent.setup();
      linkedinBackend();
      const first = renderIntegrations();

      await user.click(await expandSocialsAndGetLinkedInButton(user));
      await waitFor(() => {
        expect(within(linkedInRowElement()).getByText(/Connecting your data/)).toBeInTheDocument();
      });

      first.unmount();
      renderIntegrations();

      const button = await expandSocialsAndGetLinkedInButton(user);
      expect(within(linkedInRowElement()).getByText(/Connecting your data/)).toBeInTheDocument();
      expect(button).toBeDisabled();
    });

    it('clears Connecting and allows a new export once the server reports the sync failed', async () => {
      const user = userEvent.setup();
      server.use(integrationsHandler([linkedinRow('SYNC_FAILED')]));
      renderIntegrations();

      const button = await expandSocialsAndGetLinkedInButton(user);
      expect(
        within(linkedInRowElement()).queryByText(/Connecting your data/),
      ).not.toBeInTheDocument();
      expect(button).toBeEnabled();
    });

    it('re-reads a running sync so the row settles without a manual refresh', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        let status = 'SYNCING';
        server.use(
          http.get(`${API_BASE}/integrations`, () =>
            HttpResponse.json({ integrations: [linkedinRow(status)] }),
          ),
        );
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        renderIntegrations();
        await expandSocialsAndGetLinkedInButton(user);
        expect(within(linkedInRowElement()).getByText(/Connecting your data/)).toBeInTheDocument();

        status = 'SYNC_FAILED';
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LINKEDIN_SYNC_REFRESH_MS);
        });
        await waitFor(() => {
          expect(
            within(linkedInRowElement()).queryByText(/Connecting your data/),
          ).not.toBeInTheDocument();
        });
        expect(screen.getByRole('button', { name: 'Connect LinkedIn' })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders the LinkedIn connect affordance as a plus button', async () => {
      const user = userEvent.setup();
      renderIntegrations();

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      expect(linkedInButton.querySelector('.lucide-plus')).toBeInTheDocument();
    });

    it('spawns only one agent for concurrent sync calls that overlap in flight', async () => {
      // Server state only flips after the create call resolves, so two
      // overlapping calls would both pass a state-only guard.
      let releaseCreate: () => void = () => {};
      const createGate = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      linkedinBackend(createGate);

      const { result } = renderHook(() => useMessagesSync({} as never, async () => {}, null));
      clearCaptures();

      await act(async () => {
        const first = result.current.handleLinkedInSync();
        const second = result.current.handleLinkedInSync();
        releaseCreate();
        await Promise.all([first, second]);
      });

      expect(agentCalls().length).toBe(1);
    });

    it('lights the LinkedIn row itself as connected once the export agent is spawned', async () => {
      const user = userEvent.setup();
      linkedinBackend();
      renderIntegrations();

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      const linkedInRow = linkedInRowElement();

      expect(within(linkedInRow).queryByText(/Connecting your data/)).not.toBeInTheDocument();
      const glowOf = () =>
        Array.from(linkedInRowElement().querySelectorAll('span[aria-hidden="true"]')).find((el) =>
          (el as HTMLElement).style.backgroundImage.includes('254, 117, 3'),
        );
      expect(glowOf()).toBeUndefined();

      await user.click(linkedInButton);

      await waitFor(() => {
        expect(within(linkedInRowElement()).getByText(/Connecting your data/)).toBeInTheDocument();
      });
      expect(glowOf()).toBeDefined();
    });

    it('shows the rose Connected label on the Socials header once LinkedIn connects', async () => {
      const user = userEvent.setup();
      linkedinBackend();
      renderIntegrations();

      const linkedInButton = await expandSocialsAndGetLinkedInButton(user);
      const socialsSection = screen.getByText('Socials').closest<HTMLElement>('.rounded-lg')!;

      expect(within(socialsSection).queryByText('Connected')).not.toBeInTheDocument();

      await user.click(linkedInButton);

      await waitFor(() => {
        expect(within(socialsSection).getByText('Connected')).toBeInTheDocument();
      });
    });
  });
});
