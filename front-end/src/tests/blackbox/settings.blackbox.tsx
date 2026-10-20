import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import Settings from '@/pages/Settings';
import { resetFastModeSessionOverride } from '@/lib/fastModeSession';
import { useSaveCustomization } from '@/features/settings/hooks/useSaveCustomization';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user-123' },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
}

/** Install handlers that the Settings page actually calls on mount */
function installSettingsHandlers(overrides?: {
  userSettings?: Record<string, unknown>;
  subscription?: Record<string, unknown>;
  apiKeys?: { keys: Array<Record<string, unknown>> };
}) {
  server.use(
    http.get(`${API_BASE}/user-settings`, () => {
      return HttpResponse.json(
        overrides?.userSettings ?? {
          name: 'Test User',
          email: 'test@example.com',
          phone: '+15551234567',
          deliveryRecipientName: 'Delivery Person',
          addressLine1: '123 Main St',
          addressLine2: '',
          city: 'New York',
          state: 'NY',
          postalCode: '10001',
          country: 'United States',
          systemName: 'Rose',
          profilePicture: null,
          customSystemPrompt: 'Be helpful',
        },
      );
    }),
    http.get(`${API_BASE}/credits/subscription`, () => {
      return HttpResponse.json(
        overrides?.subscription ?? {
          tier: 10,
          upgradeOptions: [{ tier: 20, name: 'Pro', url: 'https://stripe.com/checkout/pro' }],
        },
      );
    }),
    http.get(`${API_BASE}/api-keys`, () => {
      return HttpResponse.json(overrides?.apiKeys ?? { keys: [] });
    }),
    // PUT for saving personal info
    http.put(`${API_BASE}/user-settings`, () => {
      return HttpResponse.json({ success: true });
    }),
    // PATCH for customization
    http.patch(`${API_BASE}/user-settings`, () => {
      return HttpResponse.json({ success: true });
    }),
    // POST for generating API key
    http.post(`${API_BASE}/api-keys`, () => {
      return HttpResponse.json({
        apiKey: 'TEST_API_KEY_PLACEHOLDER',
        key: {
          id: 'key-new',
          name: 'My Key',
          maskedApiKey: 'rk_t...6',
          createdAt: new Date().toISOString(),
        },
      });
    }),
    // DELETE for deleting API key
    http.delete(`${API_BASE}/api-keys/:keyId`, () => {
      return new HttpResponse(null, { status: 204 });
    }),
    // Billing portal
    http.get(`${API_BASE}/billing/portal`, () => {
      return HttpResponse.json({ url: 'https://billing.stripe.com/portal' });
    }),
  );
}

describe('Settings page', () => {
  beforeEach(() => {
    mockSession();
    installSettingsHandlers();
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    resetFastModeSessionOverride();
  });

  it('retires the customization success callback when its owner unmounts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result, unmount } = renderHook(() =>
      useSaveCustomization(
        { systemName: 'Rose', profilePicture: null, customSystemPrompt: 'Be helpful' },
        vi.fn(),
      ),
    );
    await act(async () => {
      await result.current.saveCustomization();
    });
    expect(result.current.savedCustomization).toBe(true);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders Settings heading after loading', async () => {
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });
    });

    it('renders subtitle text', async () => {
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(
          screen.getByText('Manage your account settings and preferences'),
        ).toBeInTheDocument();
      });
    });

    it('renders all four tab triggers', async () => {
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });
      expect(screen.getByRole('tab', { name: /customization/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /personal info/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /billing/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /api keys/i })).toBeInTheDocument();
      // The stock page never carries the Rose drawer's dark-styling hook.
      expect(document.querySelector('.rose-settings')).toBeNull();
    });

    it('shows customization tab content by default', async () => {
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Customize Your Assistant')).toBeInTheDocument();
      });
    });

    it('shows loading spinner before data loads', () => {
      // Use a handler that delays the response so loading state is visible
      server.use(
        http.get(`${API_BASE}/user-settings`, () => {
          return new Promise(() => {
            // never resolves → component stays in loading state
          });
        }),
      );
      renderWithProviders(<Settings />);
      expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Tab switching
  // ---------------------------------------------------------------------------

  describe('tab navigation', () => {
    it('switches to Personal Info tab', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /personal info/i }));

      await waitFor(() => {
        expect(screen.getByText('Personal Information')).toBeInTheDocument();
      });
    });

    it('shows personal info form fields with loaded data', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /personal info/i }));

      await waitFor(() => {
        expect(screen.getByLabelText('Personal Full Name')).toHaveValue('Test User');
      });
      expect(screen.getByLabelText('Email')).toHaveValue('test@example.com');
      expect(screen.getByLabelText('Verified Phone')).toHaveValue('+15551234567');
      expect(screen.getByLabelText('Verified Phone')).toBeDisabled();
      expect(screen.getByLabelText('Recipient Full Name')).toHaveValue('Delivery Person');
      expect(screen.getByLabelText('Address Line 1')).toHaveValue('123 Main St');
      expect(screen.getByLabelText('City')).toHaveValue('New York');
      expect(screen.getByLabelText('State')).toHaveValue('NY');
      expect(screen.getByLabelText('Postal Code')).toHaveValue('10001');
      expect(screen.getByLabelText('Country')).toHaveValue('United States');
      expect(screen.queryByTestId('fast-mode-toggle')).toBeNull();
    });

    it('shows Fast Mode on the account-info tab when the verified phone is an admin number', async () => {
      const user = userEvent.setup();
      installSettingsHandlers({
        userSettings: {
          name: 'Andy Prevalsky',
          email: 'andy@roselabs.ai',
          phone: '+19729777432',
          deliveryRecipientName: 'Aman Gottumukkala',
          addressLine1: '88 Howard Street',
          addressLine2: 'Apt 1413',
          city: 'San Francisco',
          state: 'CA',
          postalCode: '94105',
          country: 'United States',
          systemName: 'Rose',
          profilePicture: null,
          customSystemPrompt: 'Be helpful',
        },
      });
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /personal info/i })); // pragma: allowlist secret

      await waitFor(() => {
        expect(screen.getByLabelText('Verified Phone')).toHaveValue('+19729777432');
      });
      const toggle = screen.getByTestId('fast-mode-toggle');
      expect(toggle).toBeInTheDocument();
      expect(toggle).toHaveTextContent('Fast Mode');
      expect(screen.getByText(/same control as the chat query box/i)).toBeInTheDocument();
    });

    it('switches to Billing tab and shows subscription info', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /billing/i }));

      await waitFor(() => {
        expect(screen.getByText('Subscription & Billing')).toBeInTheDocument();
      });
      expect(screen.getByText('Current Plan')).toBeInTheDocument();
      expect(screen.getByText('$10/month')).toBeInTheDocument();
    });

    it('switches to API Keys tab', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));

      await waitFor(() => {
        expect(screen.getByText('Rose API Keys')).toBeInTheDocument();
      });
    });

    it('shows empty API keys message when no keys exist', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));

      await waitFor(() => {
        expect(screen.getByText(/no api keys yet/i)).toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // User interactions
  // ---------------------------------------------------------------------------

  describe('user interactions', () => {
    it('saves personal info on button click and captures PUT request', async () => {
      const user = userEvent.setup();
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /personal info/i }));
      await waitFor(() => {
        expect(screen.getByLabelText('Personal Full Name')).toBeInTheDocument();
      });

      // Modify the personal and delivery names independently.
      const nameInput = screen.getByLabelText('Personal Full Name');
      await user.clear(nameInput);
      await user.type(nameInput, 'Updated User');
      const recipientInput = screen.getByLabelText('Recipient Full Name');
      await user.clear(recipientInput);
      await user.type(recipientInput, 'Updated Recipient');

      // Click save
      await user.click(screen.getByRole('button', { name: /save settings/i }));

      // Verify the PUT request was captured
      await waitFor(() => {
        const putReq = capturedRequests.find(
          (r) => r.url.includes('/user-settings') && r.method === 'PUT',
        );
        expect(putReq).toBeDefined();
        expect((putReq!.body as Record<string, unknown>).name).toBe('Updated User');
        expect((putReq!.body as Record<string, unknown>).email).toBe('test@example.com');
        expect((putReq!.body as Record<string, unknown>).deliveryRecipientName).toBe(
          'Updated Recipient',
        );
        expect((putReq!.body as Record<string, unknown>).phone).toBeUndefined();
      });
    });

    it('saves customization on button click and captures PATCH request', async () => {
      clearCaptures();
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Customize Your Assistant')).toBeInTheDocument();
      });

      // Click save customization
      await user.click(screen.getByRole('button', { name: /save customization/i }));

      await waitFor(() => {
        const patchReq = capturedRequests.find(
          (r) => r.url.includes('/user-settings') && r.method === 'PATCH',
        );
        expect(patchReq).toBeDefined();
      });
    });

    it('shows Generate New Key button on API Keys tab', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate new key/i })).toBeInTheDocument();
      });
    });

    it('generates API key and captures POST request', async () => {
      const user = userEvent.setup();
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate new key/i })).toBeInTheDocument();
      });

      // Click generate - with a subscription tier it should show the form
      await user.click(screen.getByRole('button', { name: /generate new key/i }));

      // A name input and Generate button should appear
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/key name/i)).toBeInTheDocument();
      });

      await user.type(screen.getByPlaceholderText(/key name/i), 'My Test Key');
      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() => {
        const postReq = capturedRequests.find(
          (r) => r.url.includes('/api-keys') && r.method === 'POST',
        );
        expect(postReq).toBeDefined();
        expect((postReq!.body as Record<string, unknown>).name).toBe('My Test Key');
      });
    });

    it('shows newly generated key after generation', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate new key/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /generate new key/i }));
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/key name/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /^generate$/i }));

      await waitFor(() => {
        expect(screen.getByText('TEST_API_KEY_PLACEHOLDER')).toBeInTheDocument();
      });
      expect(screen.getByText(/copy & dismiss/i)).toBeInTheDocument();
    });

    it('renders existing API keys when present', async () => {
      installSettingsHandlers({
        apiKeys: {
          keys: [
            {
              id: 'key-1',
              name: 'Production Key',
              maskedApiKey: 'rk_t...abc',
              createdAt: '2026-01-15T00:00:00Z',
            },
            {
              id: 'key-2',
              name: null,
              maskedApiKey: 'rk_t...xyz',
              createdAt: '2026-02-20T00:00:00Z',
            },
          ],
        },
      });

      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));

      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
      });
      expect(screen.getByText('rk_t...abc')).toBeInTheDocument();
      // Unnamed key should show 'Unnamed'
      expect(screen.getByText('Unnamed')).toBeInTheDocument();
      expect(screen.getByText('rk_t...xyz')).toBeInTheDocument();
    });

    it('shows subscription required modal when no subscription and generating key', async () => {
      installSettingsHandlers({
        subscription: { tier: null, upgradeOptions: [] },
      });

      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /api keys/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /generate new key/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /generate new key/i }));

      await waitFor(() => {
        expect(screen.getByText('Subscription Required')).toBeInTheDocument();
      });
    });

    it('billing tab shows free tier when no subscription', async () => {
      installSettingsHandlers({
        subscription: {
          tier: null,
          upgradeOptions: [{ tier: 10, name: 'Starter', url: 'https://stripe.com/checkout' }],
        },
      });

      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /billing/i }));

      await waitFor(() => {
        expect(screen.getByText('Free tier')).toBeInTheDocument();
      });
    });

    it('billing tab shows Manage Subscription button when subscribed', async () => {
      const user = userEvent.setup();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      await user.click(screen.getByRole('tab', { name: /billing/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /manage subscription/i })).toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // API boundary captures
  // ---------------------------------------------------------------------------

  describe('API boundary captures on mount', () => {
    it('captures GET /api/user-settings on load', async () => {
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      const req = capturedRequests.find(
        (r) => r.url.includes('/user-settings') && r.method === 'GET',
      );
      expect(req).toBeDefined();
      expect(req!.headers['authorization']).toBe('Bearer test-token');
    });

    it('captures GET /api/credits/subscription on load', async () => {
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      const req = capturedRequests.find(
        (r) => r.url.includes('/credits/subscription') && r.method === 'GET',
      );
      expect(req).toBeDefined();
      expect(req!.headers['authorization']).toBe('Bearer test-token');
    });

    it('captures GET /api/api-keys on load', async () => {
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      const req = capturedRequests.find((r) => r.url.includes('/api-keys') && r.method === 'GET');
      expect(req).toBeDefined();
      expect(req!.headers['authorization']).toBe('Bearer test-token');
    });

    it('all three settings endpoints are called on initial render', async () => {
      clearCaptures();
      renderWithProviders(<Settings />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      const settingsReq = capturedRequests.find(
        (r) => r.url.endsWith('/user-settings') && r.method === 'GET',
      );
      const subscriptionReq = capturedRequests.find(
        (r) => r.url.includes('/credits/subscription') && r.method === 'GET',
      );
      const keysReq = capturedRequests.find(
        (r) => r.url.includes('/api-keys') && r.method === 'GET',
      );

      expect(settingsReq).toBeDefined();
      expect(subscriptionReq).toBeDefined();
      expect(keysReq).toBeDefined();
    });
  });
});
