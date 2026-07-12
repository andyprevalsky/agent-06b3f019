import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';

const API_BASE = 'http://localhost:3001/api';

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
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

function mockBrowserReviewSession() {
  const session = {
    access_token: 'review-token',
    refresh_token: 'review-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'review-user', phone: '+15555550123', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem(
    'app-user',
    JSON.stringify({ id: 'review-user', phone: '+15555550123', is_anonymous: false }),
  );
}

function mockAnonymousSession() {
  const session = {
    access_token: 'test-anon-token',
    refresh_token: 'test-anon-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'anon-user', is_anonymous: true },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'anon-user', is_anonymous: true }));
}

// Supabase realtime setAuth is a no-op in tests (WebSocket won't connect)
// but we need to handle the call that happens during auth initialization.

describe('Terminal page', () => {
  beforeEach(() => {
    mockSession();
    // Terminal-specific handlers beyond the defaults
    server.use(
      // User profile for settings-related components
      http.get(`${API_BASE}/user/profile`, () => {
        return HttpResponse.json({
          name: 'Test User',
          addressLine1: '',
          city: '',
          state: '',
          zip: '',
          country: '',
        });
      }),
      http.get(`${API_BASE}/user/subscription`, () => {
        return HttpResponse.json({ tier: 10 });
      }),
      http.get(`${API_BASE}/user/customization`, () => {
        return HttpResponse.json({ systemPrompt: '', contextGates: {} });
      }),
      http.get(`${API_BASE}/credits/stats`, () => {
        return HttpResponse.json({ totalTokens: 0, topModels: [] });
      }),
    );
  });

  afterEach(() => {
    setViewport(1024, 768);
    window.history.replaceState({}, '', '/');
    localStorage.clear();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Rendering tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('rendering', () => {
    it('renders without crashing with authenticated session', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        expect(document.body.textContent).not.toBe('');
      });
    });

    it('renders the Rose branding in the header', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        expect(screen.getByText('Rose')).toBeInTheDocument();
      });
    });

    it('renders the query input with placeholder', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        // When no agent selected, placeholder is "Enter any goal"
        const textarea = screen.getByPlaceholderText('Enter any goal');
        expect(textarea).toBeInTheDocument();
      });
    });

    it('renders sidebar with agent list items', async () => {
      const user = userEvent.setup({ delay: null });
      renderWithProviders(<Terminal />);

      // Sidebar starts collapsed (compact mode shows only icons, no text).
      // Expand it by clicking the toggle button.
      const expandBtn = await screen.findByLabelText('Expand sidebar');
      await user.click(expandBtn);

      // After expanding, agent goal text should be visible
      await waitFor(() => {
        expect(screen.getByText('Test agent')).toBeInTheDocument();
      });
    });

    it('shows opening animation text when no agent is selected', async () => {
      renderWithProviders(<Terminal />);
      // The first opening message is "Hello!"
      await waitFor(() => {
        expect(screen.getByText('Hello!')).toBeInTheDocument();
      });
    });

    it('shows Popular Goals carousel when no agent is selected', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        // Should show at least one popular goal button
        expect(screen.getAllByText('Maximize my luck surface area').length).toBeGreaterThan(0);
      });
    });

    it('keeps grid energy pills in the background layer below terminal content', async () => {
      renderWithProviders(<Terminal />);

      const energyLayer = await screen.findByTestId('terminal-grid-energy-layer');
      const gridLayer = screen.getByTestId('terminal-grid-background-layer');

      expect(gridLayer).toHaveClass('z-[3]');
      expect(energyLayer).toHaveClass('z-[4]');
      expect(screen.getByPlaceholderText('Enter any goal').closest('.z-\\[4\\]')).not.toBeNull();
      expect(screen.getByRole('banner')).toHaveClass('z-50');
      expect(screen.getByRole('complementary', { hidden: true })).toHaveClass('z-[50]');
    });

    it('clips grid energy pills below the landing popular goals controls', async () => {
      renderWithProviders(<Terminal />);

      const landingInput = await screen.findByPlaceholderText('Enter any goal');
      const inputAreaMask = screen.getByTestId('terminal-energy-input-area-mask');
      const landingControlsClearance = window.innerWidth < 768 ? 340 : 300;

      expect(landingInput).toBeInTheDocument();
      expect(Number(inputAreaMask.getAttribute('y'))).toBe(
        Math.max(0, window.innerHeight - landingControlsClearance),
      );
      expect(Number(inputAreaMask.getAttribute('height'))).toBe(landingControlsClearance + 5000);
    });

    it('renders Privacy and Terms links', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        expect(screen.getByText('Privacy')).toBeInTheDocument();
        expect(screen.getByText('Terms')).toBeInTheDocument();
      });
    });

    it('pushes legal links below the mobile URL bar area', async () => {
      setViewport(390, 844);

      renderWithProviders(<Terminal />);

      const legalLinks = await screen.findByTestId('terminal-legal-links');
      expect(legalLinks).toHaveClass('-bottom-8');
      expect(legalLinks).toHaveClass('md:bottom-1');
    });

    it('reserves a two-line-safe opening caption box on mobile', async () => {
      setViewport(390, 844);

      renderWithProviders(<Terminal />);

      const openingMessage = await screen.findByTestId('opening-message-display');
      expect(openingMessage).toHaveClass('min-h-16');
      expect(openingMessage).toHaveClass('max-w-[24rem]');
      expect(openingMessage).toHaveClass('md:min-h-8');
    });

    it('keeps the mobile opening loader below the floating header', async () => {
      setViewport(390, 844);

      renderWithProviders(<Terminal />);

      const openingLoader = await screen.findByTestId('terminal-opening-loader');
      expect(openingLoader).toHaveClass('top-16');
      expect(openingLoader).toHaveClass('bottom-0');
      expect(openingLoader).toHaveClass('md:inset-0');
      expect(openingLoader).toHaveClass('md:h-[100dvh]');
    });

    it('applies only a visual mobile transform to the opening ASCII art', async () => {
      setViewport(390, 844);

      renderWithProviders(<Terminal />);

      const asciiTransform = await screen.findByTestId('terminal-opening-ascii-transform');
      expect(asciiTransform).toHaveClass('scale-95');
      expect(asciiTransform).toHaveClass('translate-y-[5%]');
      expect(asciiTransform).toHaveClass('md:scale-100');
      expect(asciiTransform).toHaveClass('md:translate-y-0');
    });

    it('keeps the mobile query box low near the visual viewport bottom', async () => {
      setViewport(390, 844);

      renderWithProviders(<Terminal />);

      const inputArea = await screen.findByTestId('terminal-input-area');
      expect(inputArea).toHaveClass('pb-1');
      expect(inputArea).toHaveClass('md:pb-6');
    });

    it('lands the browser-review account on Browse by default', async () => {
      localStorage.clear();
      mockBrowserReviewSession();

      renderWithProviders(<Terminal />);

      expect(await screen.findByLabelText('URL or search')).toHaveValue('https://www.roselabs.ai');
      expect(screen.queryByRole('button', { name: /^rose$/i })).not.toBeInTheDocument();
    });

    it('opens browser-review direct agent links in Agents view', async () => {
      localStorage.clear();
      mockBrowserReviewSession();
      window.history.replaceState({}, '', '/?agent-id=agent-123');

      renderWithProviders(<Terminal />);

      expect(await screen.findByRole('button', { name: /^rose$/i })).toBeInTheDocument();
      expect(screen.queryByLabelText('URL or search')).not.toBeInTheDocument();
    });

    it('pins pending gate cards above the query input', async () => {
      window.history.replaceState({}, '', '/?agent-id=agent-gate');
      server.use(
        http.get(`${API_BASE}/agents/:agentId`, ({ params }) => {
          return HttpResponse.json({
            agent: {
              agent_id: params.agentId,
              goal: 'Gate test agent',
              model: 'rose-1-lite',
              source: 'WEB',
              reasoning_effort: 'medium',
              progress: 50,
              status: 'ACTIVE',
              status_message: null,
              temporal_workflow_id: 'wf-gate',
              token_count: 1000,
              tokens_in: 800,
              tokens_out: 200,
              tool_tokens_in: 0,
              tool_tokens_out: 0,
              tool_cost_cents: 0,
              context_size: 4096,
              message_count: 2,
              price_limit_cents: 100,
              tree_cost_cents: 10,
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:01:00Z',
              write_lock_enabled: false,
              parent_agent_id: null,
              parent_goal: null,
              verifier: null,
              tools: [],
            },
            messages: [
              {
                message_id: 'msg-gate-user',
                timestamp: '2026-01-01T00:00:00Z',
                text: 'Validate the subscription gate.',
                role: 'USER',
              },
              {
                message_id: 'msg-gate-tool',
                timestamp: '2026-01-01T00:00:01Z',
                text: 'Subscribe to let Rose complete purchases',
                role: 'TOOL',
                metadata: {
                  toolCallId: 'gate-request-1',
                  toolName: 'gate',
                  toolStatus: 'IN_PROGRESS',
                  attentionRequestId: 'attention-gate-1',
                  gate: {
                    type: 'subscription',
                    gateKey: 'subscription:test',
                    presentation: {
                      title: 'Subscribe to let Rose complete purchases',
                      reason:
                        'This checkout needs an active subscription before Rose can mint a payment card.',
                      cta: 'Subscribe · $20/mo',
                    },
                    action: {
                      kind: 'link',
                      url: 'https://roselabs.ai/subscribe?demo=gate-chip',
                    },
                  },
                },
              },
            ],
            pagination: {
              has_more: false,
              oldest_timestamp: null,
            },
          });
        }),
      );

      renderWithProviders(<Terminal />);

      const title = await screen.findByText('Subscribe to let Rose complete purchases');
      expect(screen.getAllByText('Subscribe to let Rose complete purchases')).toHaveLength(1);
      expect(screen.getByRole('button', { name: /Subscribe/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Cancel/ })).toBeInTheDocument();

      const textarea = await screen.findByPlaceholderText('Type your message...');
      expect(
        Boolean(title.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
    });

    it('does not show Browse in the sidebar for regular users', async () => {
      const user = userEvent.setup({ delay: null });
      renderWithProviders(<Terminal />);

      await user.click(await screen.findByLabelText('Expand sidebar'));

      expect(screen.queryByText('Browse')).not.toBeInTheDocument();
      expect(screen.getByText('Integrations')).toBeInTheDocument();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // User interaction tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('user interactions', () => {
    it('typing in the query input updates the value', async () => {
      const user = userEvent.setup({ delay: null });
      renderWithProviders(<Terminal />);

      const textarea = await screen.findByPlaceholderText('Enter any goal');
      await user.click(textarea);
      await user.type(textarea, 'Find me a new apartment');
      expect(textarea).toHaveValue('Find me a new apartment');
    });

    it('clicking a popular goal populates the input', async () => {
      const user = userEvent.setup({ delay: null });
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        expect(screen.getAllByText('Get me socks').length).toBeGreaterThan(0);
      });

      // Click the first instance of a popular goal
      const goalButtons = screen.getAllByText('Get me socks');
      await user.click(goalButtons[0]);

      const textarea = screen.getByPlaceholderText('Enter any goal');
      expect(textarea).toHaveValue('Get me socks');
    });

    it('submitting a goal creates a new agent via POST /api/agents', async () => {
      const user = userEvent.setup({ delay: null });
      clearCaptures();
      renderWithProviders(<Terminal />);

      const textarea = await screen.findByPlaceholderText('Enter any goal');
      await user.click(textarea);
      await user.type(textarea, 'Build me a website');

      // Submit via Cmd+Enter (meta+Enter)
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        const createReq = capturedRequests.find(
          (r) =>
            r.url.includes('/api/agents') && r.method === 'POST' && !r.url.includes('/messages'),
        );
        expect(createReq).toBeDefined();
        expect(createReq?.body).toEqual(expect.objectContaining({ goal: 'Build me a website' }));
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // API boundary capture tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('API boundary captures', () => {
    it('fetches agents list on page load (GET /api/agents)', async () => {
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        const agentsReq = capturedRequests.find(
          (r) => r.url === `${API_BASE}/agents` && r.method === 'GET',
        );
        expect(agentsReq).toBeDefined();
      });
    });

    it('fetches models on page load (GET /api/models)', async () => {
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        const modelsReq = capturedRequests.find(
          (r) => r.url.includes('/api/models') && r.method === 'GET',
        );
        expect(modelsReq).toBeDefined();
      });
    });

    it('fetches tools on page load (GET /api/tools)', async () => {
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        const toolsReq = capturedRequests.find(
          (r) => r.url.includes('/api/tools') && r.method === 'GET',
        );
        expect(toolsReq).toBeDefined();
      });
    });

    it('includes auth header in API requests', async () => {
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        const agentsReq = capturedRequests.find(
          (r) => r.url === `${API_BASE}/agents` && r.method === 'GET',
        );
        expect(agentsReq).toBeDefined();
        expect(agentsReq!.headers['authorization']).toBe('Bearer test-token');
      });
    });

    it('checks invite code status on load (GET /api/invite-codes/check)', async () => {
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        const inviteReq = capturedRequests.find(
          (r) => r.url.includes('/invite-codes/check') && r.method === 'GET',
        );
        expect(inviteReq).toBeDefined();
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Auth gating
  // ═══════════════════════════════════════════════════════════════════════════

  describe('auth gating', () => {
    it('renders gracefully without any session in localStorage', async () => {
      localStorage.clear();
      // The auth hook will try to create an anonymous session via POST /api/auth/anonymous
      // which is already handled by the default MSW handlers
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        // Should still render the page structure (Rose branding, query input)
        expect(screen.getByText('Rose')).toBeInTheDocument();
      });
    });

    it('submit without a stored session opens login and does not create an agent', async () => {
      const user = userEvent.setup({ delay: null });
      localStorage.clear();
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        expect(document.querySelector('textarea')).toBeInTheDocument();
      });
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      await user.click(textarea);
      await user.type(textarea, 'No stored session should sign in');
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        expect(screen.getByText('Start Building.')).toBeInTheDocument();
      });
      const createReq = capturedRequests.find(
        (r) => r.url.includes('/api/agents') && r.method === 'POST' && !r.url.includes('/messages'),
      );
      expect(createReq).toBeUndefined();
      // Interaction + waitFor(login modal) is slow under coverage instrumentation
      // and full-suite contention (passes fast in isolation); give it headroom.
    }, 30000);

    it('renders with anonymous session', async () => {
      localStorage.clear();
      mockAnonymousSession();
      renderWithProviders(<Terminal />);

      // Anonymous users still get the page structure and query input.
      await waitFor(() => {
        expect(screen.getByText('Rose')).toBeInTheDocument();
      });
      // The query input should render regardless of auth state
      // (it always renders, just may be disabled without auth)
      const textarea = document.querySelector('textarea');
      expect(textarea).toBeInTheDocument();
    });

    it('anonymous submit opens login and does not create an agent', async () => {
      const user = userEvent.setup({ delay: null });
      localStorage.clear();
      mockAnonymousSession();
      clearCaptures();
      renderWithProviders(<Terminal />);

      await waitFor(() => {
        expect(document.querySelector('textarea')).toBeInTheDocument();
      });
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      await user.click(textarea);
      await user.type(textarea, 'Anonymous users should sign in');
      await user.keyboard('{Meta>}{Enter}{/Meta}');

      await waitFor(() => {
        expect(screen.getByText('Start Building.')).toBeInTheDocument();
      });
      const createReq = capturedRequests.find(
        (r) => r.url.includes('/api/agents') && r.method === 'POST' && !r.url.includes('/messages'),
      );
      expect(createReq).toBeUndefined();
      // Slow under coverage instrumentation + full-suite contention (see above).
    }, 30000);
  });
});
