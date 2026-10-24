import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { clearIpcMock, installIpcMock } from './ipc-mock';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import OnboardingData from '../../ui/features/onboarding/components/OnboardingData';
import RingCarousel from '../../ui/features/onboarding/components/data/RingCarousel';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import type { BrowserInfo, BrowserType, IPC } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// react-plaid-link mock — controllable handle for tests that need the
// Financials flow. The real SDK opens an iframe, which jsdom can't render.
// ---------------------------------------------------------------------------
interface PlaidLinkController {
  fireSuccess: (publicToken: string) => void;
  fireExit: (err?: { display_message?: string; error_message?: string }) => void;
  opened: boolean;
  lastToken: string | null;
}
const plaidLink: PlaidLinkController = {
  fireSuccess: () => {},
  fireExit: () => {},
  opened: false,
  lastToken: null,
};
vi.mock('react-plaid-link', () => ({
  usePlaidLink: (opts: {
    token: string | null;
    onSuccess: (
      publicToken: string,
      metadata: {
        institution: { institution_id: string; name: string } | null;
        accounts: Array<{
          id: string;
          name: string;
          mask: string | null;
          type: string;
          subtype: string | null;
        }>;
        link_session_id: string;
      }
    ) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }) => {
    plaidLink.lastToken = opts.token;
    plaidLink.fireSuccess = (publicToken: string): void => {
      opts.onSuccess(publicToken, {
        institution: { institution_id: 'ins_109508', name: 'First Platypus Bank' },
        accounts: [
          {
            id: 'acct-1',
            name: 'Plaid Checking',
            mask: '0000',
            type: 'depository',
            subtype: 'checking',
          },
        ],
        link_session_id: 'sess-onboarding-1',
      });
    };
    plaidLink.fireExit = (err) => opts.onExit(err ?? null);
    return {
      open: () => {
        plaidLink.opened = true;
      },
      ready: opts.token !== null,
      exit: () => {},
      error: null,
    };
  },
}));

/**
 * Blackbox coverage for the onboarding data step (3D ring redesign). Renders
 * through the real component boundary, the real integrations-page hooks, MSW
 * backend handlers, and the mocked Electron preload bridge wrapped in the
 * same IntegrationHandlersProvider wiring the app root (ui/main.tsx) uses.
 *
 * State sketch:
 *   loading --GET integrations + IPC browsers--> ring with active category card
 *   ring icon / Next --> rotates to category, sub-card swaps rows
 *   sub-row + click --> backend request or IPC call, row flips to connected
 *   all six categories connected --> "Get Started" (navi CTA) --> onComplete()
 *   Skip for now --> onComplete()
 */

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';

const INSTALLED_BROWSERS: BrowserInfo[] = [
  { type: 'chrome', name: 'Chrome', isInstalled: true, needsManualPassword: false },
  { type: 'edge', name: 'Microsoft Edge', isInstalled: true, needsManualPassword: false },
  { type: 'brave', name: 'Brave', isInstalled: true, needsManualPassword: false },
  { type: 'atlas', name: 'ChatGPT Atlas', isInstalled: true, needsManualPassword: true },
];

function primeSession(): void {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'test-access-token-onboarding-data',
      refresh_token: 'test-refresh-token',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'test-user-onboarding-data' },
    })
  );
}

function subCard(): HTMLElement {
  return screen.getByTestId('onboarding-sub-card');
}

/** Ring icons are buttons labeled with the category name. */
async function goToCategory(user: ReturnType<typeof userEvent.setup>, name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name }));
}

function connectButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: `Connect ${label}` });
}

function installOnboardingApiMocks(): ReturnType<typeof installIpcMock> {
  return installIpcMock({
    auth: {
      check: vi.fn(async () => null),
      save: vi.fn(async () => ({ success: true })),
      clear: vi.fn(async () => ({ success: true })),
    },
    getInstalledBrowsers: vi.fn(async () => INSTALLED_BROWSERS),
    syncBrowser: vi.fn(async () => ({ success: true })),
    syncBrowserPasswords: vi.fn(async () => ({ success: true })),
    openAutoFillSettings: vi.fn(async () => ({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    })),
    checkAutoFillSettings: vi.fn(async () => ({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    })),
    checkIMessageAccess: vi.fn(async () => true),
    openFullDiskAccessSettings: vi.fn(async () => ({ success: true })),
    startIMessageUpload: vi.fn(async () => ({ success: true })),
    openExternal: vi.fn(async () => ({ success: true })),
    openKeychainAccess: vi.fn(async () => ({ success: true })),
    openPasswordsApp: vi.fn(async () => ({ success: true })),
    onPasskeysImportComplete: vi.fn(() => vi.fn()),
    onClaudeSetupStatus: vi.fn(() => vi.fn()),
    claudeCode: {
      hasCredentials: vi.fn(async () => true),
      syncCredentials: vi.fn(async () => ({ success: true })),
      setMockNoClaudeCode: vi.fn(async () => ({ success: true })),
    },
    gptCode: {
      hasCredentials: vi.fn(async () => true),
      syncCredentials: vi.fn(async () => ({ success: true })),
    },
    atlas: {
      storePassword: vi.fn(async () => ({ success: true })),
      hasPassword: vi.fn(async () => false),
      clearPassword: vi.fn(async () => ({ success: true })),
    },
    whatsapp: {
      hasCredentials: vi.fn(async () => true),
      getLinkedPhoneNumber: vi.fn(async () => '+15555550123'),
      isConnected: vi.fn(async () => false),
      connect: vi.fn(async () => ({ success: true })),
      disconnect: vi.fn(async () => ({ success: true })),
      logout: vi.fn(async () => ({ success: true })),
    },
    onWhatsAppQRCode: vi.fn((callback) => {
      callback('test-whatsapp-qr-code');
      return vi.fn();
    }),
    telegram: {
      hasSession: vi.fn(async () => true),
      hasApiCredentials: vi.fn(async () => true),
      isConnected: vi.fn(async () => true),
      connectWithExistingSession: vi.fn(async () => ({ success: true })),
      disconnect: vi.fn(async () => ({ success: true })),
      logout: vi.fn(async () => ({ success: true })),
      syncHistorical: vi.fn(async () => ({ success: true, count: 12 })),
      startAuth: vi.fn(async () => ({ success: true })),
      submitCode: vi.fn(async () => ({ success: true })),
      submitPassword: vi.fn(async () => ({ success: true })),
      cancelAuth: vi.fn(async () => ({ success: true })),
    },
    onTelegramNeedCode: vi.fn(),
    onTelegramNeedPassword: vi.fn(),
    onTelegramAuthComplete: vi.fn(),
    onTelegramAuthError: vi.fn(),
  });
}

/** Mirrors the electronHandlers wiring in ui/main.tsx over the ipc mock. */
function buildTestHandlers() {
  const api = (): IPC => window.api;
  return {
    iMessage: {
      isAvailable: true,
      onClick: async () => {
        const hasAccess = await api().checkIMessageAccess();
        if (!hasAccess) {
          await api().openFullDiskAccessSettings();
          return;
        }
        const result = await api().startIMessageUpload();
        if (!result.success) throw new Error(result.message ?? 'Upload failed');
      },
    },
    claudeCode: {
      isAvailable: true,
      hasCredentials: () => api().claudeCode!.hasCredentials(),
      syncCredentials: () => api().claudeCode!.syncCredentials(),
    },
    gptCode: {
      isAvailable: true,
      hasCredentials: () => api().gptCode!.hasCredentials(),
      syncCredentials: () => api().gptCode!.syncCredentials(),
    },
    passkeys: {
      isAvailable: true,
      openAutoFillSettings: () => api().openAutoFillSettings(),
      checkAutoFillSettings: () => api().checkAutoFillSettings(),
      openPasswordsApp: () => api().openPasswordsApp(),
      onImportComplete: (
        callback: (result: {
          success: boolean;
          count?: number;
          passkeyCount?: number;
          passwordCount?: number;
          message?: string;
        }) => void
      ) => api().onPasskeysImportComplete?.(callback) ?? (() => {}),
      enroll: async () => ({ success: false, message: 'not available in tests' }),
    },
    browserCookies: {
      isAvailable: true,
      getInstalledBrowsers: async () => api().getInstalledBrowsers(),
      syncBrowser: async (browserType: string, keychainPassword?: string) => {
        const result = await api().syncBrowser(
          browserType as BrowserType,
          keychainPassword !== undefined && keychainPassword !== ''
            ? { keychainPassword }
            : undefined
        );
        if (!result.success) throw new Error(result.message ?? 'Sync failed');
      },
      syncBrowserPasswords: async (browserType: string, config?: { keychainPassword?: string }) => {
        return api().syncBrowserPasswords(browserType as BrowserType, config);
      },
      storeAtlasPassword: async (password: string) => api().atlas!.storePassword(password),
      openKeychainAccess: async (searchQuery?: string) => api().openKeychainAccess(searchQuery),
    },
  };
}

interface IntegrationFixture {
  id: string;
  name: string;
  status: string;
  isActive?: boolean;
  config?: Record<string, unknown>;
}

function installBackendMocks(integrations: IntegrationFixture[] = []): void {
  server.use(
    http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations })),
    http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    http.post(`${API_BASE}/integrations/email/gmail/start`, () =>
      HttpResponse.json({ authUrl: 'https://accounts.google.com/o/oauth2/test' })
    ),
    // LinkedIn connect (front-end createLinkedInSyncAgentApi): create the export
    // agent, then record it via /integrations/linkedin/sync. Mirror the real
    // backend contracts: create returns `agent_id`, and sync rejects a missing one.
    http.post(`${API_BASE}/agents`, () =>
      HttpResponse.json({ agent_id: 'linkedin-agent-1', status: 'ACTIVE' }, { status: 201 })
    ),
    http.post(`${API_BASE}/integrations/linkedin/sync`, async ({ request }) => {
      const body = (await request.json()) as { agent_id?: unknown };
      if (typeof body.agent_id !== 'string' || body.agent_id === '') {
        return HttpResponse.json({ error: 'agent_id is required' }, { status: 400 });
      }
      return HttpResponse.json({
        integration_id: 'linkedin',
        status: 'SYNCING',
        agent_id: body.agent_id,
      });
    })
  );
}

const DEFAULT_INTEGRATIONS: IntegrationFixture[] = [
  { id: 'chrome', name: 'chrome', status: 'CONNECTED', isActive: true },
  {
    id: 'gmail',
    name: 'gmail',
    status: 'SYNCING',
    isActive: true,
    config: { connectedEmails: ['andy@example.com'] },
  },
  { id: 'imessage', name: 'imessage', status: 'CONNECTED', isActive: true },
  { id: 'whatsapp', name: 'whatsapp', status: 'CONNECTED', isActive: true },
  { id: 'telegram', name: 'telegram', status: 'CONNECTED', isActive: true },
  { id: 'apple_passwords', name: 'apple_passwords', status: 'CONNECTED', isActive: true },
];

function renderOnboarding(onComplete: () => void = () => {}) {
  return renderWithProviders(
    <IntegrationHandlersProvider handlers={buildTestHandlers()}>
      <OnboardingData onComplete={onComplete} />
    </IntegrationHandlersProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  primeSession();
  installBackendMocks(DEFAULT_INTEGRATIONS);
  plaidLink.opened = false;
  plaidLink.lastToken = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  clearIpcMock();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('OnboardingData (ring)', () => {
  it('starts the celebration spin when the ring mounts complete', () => {
    renderWithProviders(
      <RingCarousel
        categories={[
          { id: 'one', name: 'One', glyph: <span>1</span>, connected: true },
          { id: 'two', name: 'Two', glyph: <span>2</span>, connected: true },
        ]}
        activeIndex={0}
        onSelect={() => {}}
        celebrate
      />
    );

    expect(screen.getByRole('button', { name: 'One' })).toHaveClass('onb-no-anim');
  });

  it('renders the ring, shows connected state, and Skip calls onComplete', async () => {
    const api = installOnboardingApiMocks();
    const onComplete = vi.fn();
    const user = userEvent.setup();

    renderOnboarding(onComplete);

    await screen.findByText('Connect your Data');
    await waitFor(() => expect(api.getInstalledBrowsers).toHaveBeenCalled());

    // One ring icon button per category.
    for (const name of [
      'Browser Sync',
      'Passwords',
      'Compute',
      'Messages',
      'Socials',
      'Financials',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    // Active category starts on Browser Sync: installed browsers listed.
    await waitFor(() => expect(within(subCard()).getByText('Microsoft Edge')).toBeInTheDocument());
    expect(screen.queryByText('andy@example.com')).not.toBeInTheDocument();

    // Rotate to Messages via the ring icon: Gmail chip shows connected email.
    await goToCategory(user, 'Messages');
    await waitFor(() => expect(screen.getByText('andy@example.com')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows an empty browser state when no supported browsers are installed', async () => {
    const api = installOnboardingApiMocks();
    api.getInstalledBrowsers.mockResolvedValueOnce([]);
    installBackendMocks([]);

    renderOnboarding();
    await screen.findByText('Connect your Data');

    await waitFor(() =>
      expect(screen.getByText(/No supported browsers detected/i)).toBeInTheDocument()
    );
    // Not all categories connected -> primary button is Next, not Get Started.
    expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
  });

  it('Next walks the ring and jumps to unconnected categories from the end', async () => {
    installOnboardingApiMocks();
    installBackendMocks([]);
    const user = userEvent.setup();

    renderOnboarding();
    await screen.findByText('Connect your Data');

    const next = screen.getByRole('button', { name: /next/i });
    await user.click(next); // -> Passwords
    await waitFor(() => expect(within(subCard()).getByText('Chrome')).toBeInTheDocument());
    await user.click(next); // -> Compute
    await waitFor(() =>
      expect(within(subCard()).getByText('Claude Subscription')).toBeInTheDocument()
    );
    await user.click(next); // -> Messages
    await user.click(next); // -> Socials
    await user.click(next); // -> Financials (last)
    await waitFor(() => expect(within(subCard()).getByText('Your Bank')).toBeInTheDocument());
    await user.click(next); // last + unconnected everywhere -> wraps to Browser Sync
    await waitFor(() => expect(within(subCard()).getByText('Microsoft Edge')).toBeInTheDocument());
  });

  it('drives representative connector actions across categories', async () => {
    const api = installOnboardingApiMocks();
    // Empty fixtures: every row must start idle so each "Connect X" exists.
    installBackendMocks([]);
    const user = userEvent.setup();

    renderOnboarding();
    await screen.findByText('Connect your Data');
    await waitFor(() => expect(within(subCard()).getByText('Microsoft Edge')).toBeInTheDocument());

    // Browsers: plain sync + Atlas keychain modal.
    await user.click(connectButton('Microsoft Edge'));
    await waitFor(() => expect(api.syncBrowser).toHaveBeenCalledWith('edge', undefined));

    await user.click(connectButton('ChatGPT Atlas'));
    expect(await screen.findByText('Sync Atlas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    // Passwords.
    await goToCategory(user, 'Passwords');
    await waitFor(() =>
      expect(within(subCard()).getByText('Apple Passwords & Passkeys')).toBeInTheDocument()
    );
    await user.click(connectButton('Chrome'));
    await waitFor(() => expect(api.syncBrowserPasswords).toHaveBeenCalledWith('chrome', undefined));

    await user.click(connectButton('Apple Passwords & Passkeys'));
    expect(await screen.findByText('Sync Apple Passwords & Passkeys')).toBeInTheDocument();
    const modalSyncButtons = screen.getAllByRole('button', { name: /^Sync$/i });
    await user.click(modalSyncButtons[modalSyncButtons.length - 1]);
    await waitFor(() => {
      expect(api.openAutoFillSettings).toHaveBeenCalledTimes(1);
      expect(api.openPasswordsApp).toHaveBeenCalledTimes(1);
    });
    const importComplete = vi.mocked(api.onPasskeysImportComplete!).mock.calls[0]?.[0];
    expect(importComplete).toEqual(expect.any(Function));
    act(() => {
      importComplete?.({ success: true, count: 1, passkeyCount: 1, passwordCount: 0 });
    });
    await waitFor(() => {
      expect(screen.queryByText('Sync Apple Passwords & Passkeys')).not.toBeInTheDocument();
    });

    // Compute.
    await goToCategory(user, 'Compute');
    await waitFor(() => expect(within(subCard()).getByText('Gemini')).toBeInTheDocument());
    expect(within(subCard()).getByText(/coming soon/i)).toBeInTheDocument();
    await user.click(connectButton('Claude Subscription'));
    await waitFor(() => expect(api.claudeCode!.syncCredentials).toHaveBeenCalledTimes(1));
    await user.click(connectButton('ChatGPT Subscription'));
    await waitFor(() => expect(api.gptCode!.syncCredentials).toHaveBeenCalledTimes(1));

    // Messages.
    await goToCategory(user, 'Messages');
    await waitFor(() => expect(within(subCard()).getByText('iMessage')).toBeInTheDocument());
    await user.click(connectButton('iMessage'));
    await waitFor(() => expect(api.startIMessageUpload).toHaveBeenCalledTimes(1));
    await user.click(connectButton('WhatsApp'));
    await waitFor(() => expect(api.whatsapp?.connect).toHaveBeenCalledTimes(1));
    await user.click(connectButton('Telegram'));
    await waitFor(() => expect(api.telegram?.syncHistorical).toHaveBeenCalledTimes(1));

    // Socials.
    await goToCategory(user, 'Socials');
    await waitFor(() => expect(within(subCard()).getByText('LinkedIn')).toBeInTheDocument());
    expect(within(subCard()).getAllByText(/coming soon/i)).toHaveLength(2);
    await user.click(connectButton('LinkedIn'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'LinkedIn connected' })).toBeInTheDocument()
    );
  }, 30_000);

  it('surfaces actionable connector errors in every affected category', async () => {
    const api = installOnboardingApiMocks();
    installBackendMocks([]);
    api.syncBrowser.mockRejectedValue(new Error('Browser sync exploded'));
    api.syncBrowserPasswords.mockRejectedValue(new Error('Password sync exploded'));
    api.claudeCode!.syncCredentials.mockRejectedValue(new Error('Compute sync exploded'));
    api.startIMessageUpload.mockResolvedValue({
      success: false,
      message: 'iMessage sync exploded',
    });
    server.use(
      http.post(`${API_BASE}/integrations/email/gmail/start`, () =>
        HttpResponse.json({ error: 'Gmail connect exploded' }, { status: 500 })
      ),
      http.post(`${API_BASE}/agents`, () =>
        HttpResponse.json({ error: 'LinkedIn sync exploded' }, { status: 500 })
      )
    );
    const user = userEvent.setup();

    renderOnboarding();
    await screen.findByText('Connect your Data');
    await waitFor(() => expect(within(subCard()).getByText('Microsoft Edge')).toBeInTheDocument());

    await user.click(connectButton('Microsoft Edge'));
    expect(await within(subCard()).findByText('Browser sync exploded')).toBeInTheDocument();

    await goToCategory(user, 'Passwords');
    await user.click(connectButton('Chrome'));
    expect(await within(subCard()).findByText('Password sync exploded')).toBeInTheDocument();

    await goToCategory(user, 'Compute');
    await user.click(connectButton('Claude Subscription'));
    expect(await within(subCard()).findByText('Compute sync exploded')).toBeInTheDocument();

    await goToCategory(user, 'Messages');
    await user.click(connectButton('iMessage'));
    expect(await within(subCard()).findByText('iMessage sync exploded')).toBeInTheDocument();
    await user.click(connectButton('Gmail'));
    expect(await within(subCard()).findByText('Gmail connect exploded')).toBeInTheDocument();

    await goToCategory(user, 'Socials');
    await user.click(connectButton('LinkedIn'));
    expect(await within(subCard()).findByText('LinkedIn sync exploded')).toBeInTheDocument();
  });

  it('removes the WhatsApp QR listener after a terminal connection result', async () => {
    const api = installOnboardingApiMocks();
    installBackendMocks([]);
    const qrCleanup = vi.fn();
    api.whatsapp!.hasCredentials.mockResolvedValue(false);
    vi.mocked(api.onWhatsAppQRCode!).mockImplementation((callback) => {
      callback('terminal-qr-code');
      return qrCleanup;
    });
    const user = userEvent.setup();

    renderOnboarding();
    await screen.findByText('Connect your Data');
    await goToCategory(user, 'Messages');
    await user.click(connectButton('WhatsApp'));

    await waitFor(() => expect(api.whatsapp?.connect).toHaveBeenCalledTimes(1));
    expect(qrCleanup).toHaveBeenCalledTimes(1);
  });

  it('shows Get Started once every category is connected and completes', async () => {
    installOnboardingApiMocks();
    installBackendMocks([
      ...DEFAULT_INTEGRATIONS,
      { id: 'claude_code', name: 'claude_code', status: 'CONNECTED', isActive: true },
      { id: 'linkedin', name: 'linkedin', status: 'CONNECTED', isActive: true },
    ]);
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [
            {
              id: 'item-1',
              plaidItemId: 'plaid_item_1',
              institutionId: 'ins_chase',
              institutionName: 'Chase',
              status: 'ACTIVE',
              accounts: [],
            },
          ],
        })
      )
    );
    const onComplete = vi.fn();
    const user = userEvent.setup();

    renderOnboarding(onComplete);
    await screen.findByText('Connect your Data');

    const getStarted = await screen.findByRole('button', { name: /get started/i });
    await user.click(getStarted);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  describe('Financials (Plaid)', () => {
    async function goToFinancials(user: ReturnType<typeof userEvent.setup>): Promise<void> {
      await screen.findByText('Connect your Data');
      await goToCategory(user, 'Financials');
      await waitFor(() => expect(within(subCard()).getByText('Your Bank')).toBeInTheDocument());
    }

    it('renders the Financials category with the Your Bank row', async () => {
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);
      expect(screen.getByText('Connect your financial accounts')).toBeInTheDocument();
    });

    it('hydrates connected banks from /api/integrations/plaid/items', async () => {
      server.use(
        http.get(`${API_BASE}/integrations/plaid/items`, () =>
          HttpResponse.json({
            items: [
              {
                id: 'item-1',
                plaidItemId: 'plaid_item_1',
                institutionId: 'ins_chase',
                institutionName: 'Chase',
                status: 'ACTIVE',
                accounts: [],
              },
            ],
          })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);
      await waitFor(() => expect(screen.getByText('Chase')).toBeInTheDocument());
    });

    it('clicking Your Bank requests a link token and opens Plaid Link', async () => {
      let linkTokenRequests = 0;
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () => {
          linkTokenRequests += 1;
          return HttpResponse.json({
            link_token: 'link-onboarding-1',
            expiration: '2026-05-12T21:00:00Z',
            request_id: 'req-1',
          });
        })
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);

      await user.click(connectButton('Your Bank'));
      await waitFor(() => expect(linkTokenRequests).toBe(1));
      await waitFor(() => expect(plaidLink.opened).toBe(true));
    });

    it('on Plaid Link success, exchanges the public token and shows the bank chip', async () => {
      let exchanged = false;
      let plaidItems: Array<Record<string, unknown>> = [];
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
          HttpResponse.json({
            link_token: 'link-onboarding-2',
            expiration: '2026-05-12T21:00:00Z',
            request_id: 'req-2',
          })
        ),
        http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () => {
          exchanged = true;
          plaidItems = [
            {
              id: 'item-x',
              plaidItemId: 'plaid_item_x',
              institutionId: 'ins_109508',
              institutionName: 'First Platypus Bank',
              status: 'ACTIVE',
              accounts: [],
            },
          ];
          return HttpResponse.json({ item: plaidItems[0] });
        }),
        http.get(`${API_BASE}/integrations/plaid/items`, () =>
          HttpResponse.json({ items: plaidItems })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);

      await user.click(connectButton('Your Bank'));
      await waitFor(() => expect(plaidLink.opened).toBe(true));
      plaidLink.fireSuccess('public-sandbox-onboarding');
      await waitFor(() => expect(exchanged).toBe(true));
      await waitFor(() => expect(screen.getByText('First Platypus Bank')).toBeInTheDocument());
    });

    it('shows an error if link-token creation fails', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
          HttpResponse.json({ error: 'Plaid unavailable' }, { status: 502 })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);

      await user.click(connectButton('Your Bank'));
      await waitFor(() =>
        expect(within(subCard()).getByText(/plaid unavailable/i)).toBeInTheDocument()
      );
      expect(plaidLink.opened).toBe(false);
    });

    it('surfaces a Plaid Link onExit display_message', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
          HttpResponse.json({
            link_token: 'link-onboarding-4',
            expiration: '2026-05-12T21:00:00Z',
            request_id: 'req-4',
          })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderOnboarding();
      await goToFinancials(user);

      await user.click(connectButton('Your Bank'));
      await waitFor(() => expect(plaidLink.opened).toBe(true));
      plaidLink.fireExit({ display_message: 'Bank session aborted' });
      await waitFor(() =>
        expect(within(subCard()).getByText(/bank session aborted/i)).toBeInTheDocument()
      );
    });
  });
});
