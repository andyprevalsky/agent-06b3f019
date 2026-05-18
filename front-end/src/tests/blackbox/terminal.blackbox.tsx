import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';

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
      const user = userEvent.setup();
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

    it('renders Privacy and Terms links', async () => {
      renderWithProviders(<Terminal />);
      await waitFor(() => {
        expect(screen.getByText('Privacy')).toBeInTheDocument();
        expect(screen.getByText('Terms')).toBeInTheDocument();
      });
    });

    it('lands the browser-review account on Browse by default', async () => {
      localStorage.clear();
      mockBrowserReviewSession();

      renderWithProviders(<Terminal />);

      expect(await screen.findByLabelText('URL or search')).toHaveValue('https://www.roselabs.ai');
      expect(screen.queryByRole('button', { name: /^rose$/i })).not.toBeInTheDocument();
    });

    it('does not show Browse in the sidebar for regular users', async () => {
      const user = userEvent.setup();
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
      const user = userEvent.setup();
      renderWithProviders(<Terminal />);

      const textarea = await screen.findByPlaceholderText('Enter any goal');
      await user.click(textarea);
      await user.type(textarea, 'Find me a new apartment');
      expect(textarea).toHaveValue('Find me a new apartment');
    });

    it('clicking a popular goal populates the input', async () => {
      const user = userEvent.setup();
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
      const user = userEvent.setup();
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
        expect((createReq!.body as any).goal).toBe('Build me a website');
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
      const user = userEvent.setup();
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
    });

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
      const user = userEvent.setup();
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
    });
  });
});
