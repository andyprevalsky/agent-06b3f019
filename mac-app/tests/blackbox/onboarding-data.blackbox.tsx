import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { clearIpcMock, installIpcMock } from './ipc-mock';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import OnboardingData from '../../ui/features/onboarding/components/OnboardingData';
import type { BrowserInfo } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// react-plaid-link mock — controllable handle for tests that need the Banking
// flow. The real SDK opens an iframe, which jsdom can't render.
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
 * Blackbox coverage for the onboarding data step. This is intentionally broad:
 * it renders through the real component boundary, real API helpers, MSW backend
 * handlers, and the mocked Electron preload bridge.
 *
 * State sketch:
 *   loading --GET integrations/settings + IPC browsers--> collapsed integration list
 *   collapsed section --click icon--> expanded section, all other sections collapsed
 *   expanded connector --click connector action--> backend request or IPC call
 *   browser+gmail connected --click Continue--> onComplete()
 */

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';

const INSTALLED_BROWSERS: BrowserInfo[] = [
  { type: 'chrome', name: 'Chrome', isInstalled: true, needsManualPassword: false },
  { type: 'edge', name: 'Microsoft Edge', isInstalled: true, needsManualPassword: false },
  { type: 'brave', name: 'Brave', isInstalled: true, needsManualPassword: false },
  { type: 'arc', name: 'Arc', isInstalled: true, needsManualPassword: false },
  { type: 'opera', name: 'Opera', isInstalled: true, needsManualPassword: false },
  { type: 'vivaldi', name: 'Vivaldi', isInstalled: true, needsManualPassword: false },
  { type: 'chromium', name: 'Chromium', isInstalled: true, needsManualPassword: false },
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

function section(label: string): HTMLElement {
  const labelNode = screen.getByText(label);
  const root = labelNode.closest('.rounded-xl');
  if (!(root instanceof HTMLElement)) {
    throw new Error(`Could not find section root for ${label}`);
  }
  return root;
}

function sectionToggle(label: string): HTMLElement {
  return within(section(label)).getAllByRole('button')[0];
}

function rowAction(root: HTMLElement, label: string): HTMLElement {
  const labelNode = within(root).getByText(label);
  const row = labelNode.closest('div.flex.items-center.justify-between');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find row for ${label}`);
  }
  return within(row).getAllByRole('button')[0];
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

function installBackendMocks(): void {
  server.use(
    http.get(`${API_BASE}/integrations`, () =>
      HttpResponse.json({
        integrations: [
          { id: 'chrome', name: 'chrome', status: 'CONNECTED' },
          {
            id: 'gmail',
            name: 'gmail',
            status: 'SYNCING',
            config: { connectedEmails: ['andy@example.com'] },
          },
          { id: 'imessage', name: 'imessage', status: 'CONNECTED' },
          { id: 'whatsapp', name: 'whatsapp', status: 'CONNECTED' },
          { id: 'telegram', name: 'telegram', status: 'CONNECTED' },
          { id: 'apple_passwords', name: 'apple_passwords', status: 'CONNECTED' },
        ],
      })
    ),
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ onboardingCompletedAt: null })),
    http.post(`${API_BASE}/integrations/passwords/request`, () =>
      HttpResponse.json({ success: true })
    ),
    http.post(`${API_BASE}/agents`, () => HttpResponse.json({ id: 'linkedin-agent-1' })),
    http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] }))
  );
}

beforeEach(() => {
  localStorage.clear();
  primeSession();
  installBackendMocks();
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

describe('OnboardingData', () => {
  it('loads Electron and backend data, then allows continue when browser and Gmail are connected', async () => {
    const api = installOnboardingApiMocks();
    const onComplete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<OnboardingData onComplete={onComplete} />);

    await screen.findByText('Connect your Data');

    expect(api.getInstalledBrowsers).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Browser Sync')).toBeInTheDocument();
    expect(screen.getByText('Passwords')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Socials')).toBeInTheDocument();
    expect(screen.queryByText('andy@example.com')).not.toBeInTheDocument();

    await user.click(sectionToggle('Messages'));
    expect(screen.getByText('andy@example.com')).toBeInTheDocument();

    const continueButton = screen.getByRole('button', { name: /continue/i });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('shows an empty browser state when no supported browsers are installed', async () => {
    const api = installOnboardingApiMocks();
    api.getInstalledBrowsers.mockResolvedValueOnce([]);
    server.use(http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations: [] })));
    const user = userEvent.setup();

    renderWithProviders(<OnboardingData onComplete={() => {}} />);
    await screen.findByText('Connect your Data');

    await user.click(sectionToggle('Browser Sync'));

    expect(screen.getByText(/No supported browsers detected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });

  it('expands every data connector section and drives representative actions', async () => {
    const api = installOnboardingApiMocks();
    const user = userEvent.setup();

    renderWithProviders(<OnboardingData onComplete={() => {}} />);
    await screen.findByText('Connect your Data');

    await user.click(sectionToggle('Browser Sync'));
    for (const browser of INSTALLED_BROWSERS) {
      expect(within(section('Browser Sync')).getByText(browser.name)).toBeInTheDocument();
    }

    await user.click(rowAction(section('Browser Sync'), 'Microsoft Edge'));
    await waitFor(() => {
      expect(api.syncBrowser).toHaveBeenCalledWith('edge');
    });

    await user.click(rowAction(section('Browser Sync'), 'ChatGPT Atlas'));
    expect(screen.getByText('Sync Atlas')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    await user.click(sectionToggle('Passwords'));
    const passwords = section('Passwords');
    expect(within(passwords).getByText('Chrome')).toBeInTheDocument();
    expect(within(passwords).getByText('Apple Passwords & Passkeys')).toBeInTheDocument();
    expect(within(passwords).getByText('ChatGPT Atlas')).toBeInTheDocument();

    await user.click(rowAction(passwords, 'Chrome'));
    await waitFor(() => {
      expect(api.syncBrowserPasswords).toHaveBeenCalledWith('chrome');
    });

    await user.click(rowAction(passwords, 'Apple Passwords & Passkeys'));
    expect(screen.getByText('Sync Apple Passwords & Passkeys')).toBeInTheDocument();

    const modalSyncButtons = screen.getAllByRole('button', { name: /^Sync$/i });
    await user.click(modalSyncButtons[modalSyncButtons.length - 1]);
    await waitFor(() => {
      expect(api.openAutoFillSettings).toHaveBeenCalledTimes(1);
      expect(api.openPasswordsApp).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('button', { name: /Syncing/i })).toBeDisabled();

    const importComplete = vi.mocked(api.onPasskeysImportComplete).mock.calls[0]?.[0];
    expect(importComplete).toEqual(expect.any(Function));
    act(() => {
      importComplete?.({ success: true, count: 1, passkeyCount: 1, passwordCount: 0 });
    });
    await waitFor(() => {
      expect(screen.queryByText('Sync Apple Passwords & Passkeys')).not.toBeInTheDocument();
    });

    await user.click(sectionToggle('Messages'));
    const messages = section('Messages');
    expect(within(messages).getByText('iMessage')).toBeInTheDocument();
    expect(within(messages).getByText('WhatsApp')).toBeInTheDocument();
    expect(within(messages).getByText('Telegram')).toBeInTheDocument();
    expect(within(messages).getByText('Gmail')).toBeInTheDocument();

    await user.click(rowAction(messages, 'iMessage'));
    await waitFor(() => {
      expect(api.startIMessageUpload).toHaveBeenCalledTimes(1);
    });

    await user.click(rowAction(messages, 'WhatsApp'));
    await waitFor(() => {
      expect(api.whatsapp?.connect).toHaveBeenCalledTimes(1);
    });

    await user.click(rowAction(messages, 'Telegram'));
    await waitFor(() => {
      expect(api.telegram?.syncHistorical).toHaveBeenCalledTimes(1);
    });

    await user.click(sectionToggle('Socials'));
    const socials = section('Socials');
    expect(within(socials).getByText('X')).toBeInTheDocument();
    expect(within(socials).getByText('LinkedIn')).toBeInTheDocument();
    expect(within(socials).getByText('Instagram')).toBeInTheDocument();

    await user.click(rowAction(socials, 'LinkedIn'));
    await waitFor(() => {
      expect(screen.getByText('LinkedIn')).toBeInTheDocument();
    });
  }, 30_000);

  describe('Banking (Plaid)', () => {
    it('renders the Banking card with default CTA copy', async () => {
      installOnboardingApiMocks();
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      expect(screen.getByText('Banking')).toBeInTheDocument();
      expect(screen.getByText(/Connect a bank account via Plaid/i)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /plaid/i })).not.toBeInTheDocument();
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
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');
      await waitFor(() => expect(screen.getByText('Chase')).toBeInTheDocument());
    });

    it('clicking the Banking sync button requests a link token and opens Plaid Link', async () => {
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
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      const bankingButton = within(section('Banking')).getByRole('button');
      await user.click(bankingButton);

      await waitFor(() => expect(linkTokenRequests).toBe(1));
      await waitFor(() => expect(plaidLink.opened).toBe(true));
    });

    it('on Plaid Link success, exchanges the public token and shows the green check', async () => {
      let exchanged = false;
      let plaidItems: Array<{
        id: string;
        plaidItemId: string;
        institutionId: string | null;
        institutionName: string | null;
        status: string;
        accounts: unknown[];
      }> = [];
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
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      const bankingButton = within(section('Banking')).getByRole('button');
      await user.click(bankingButton);

      await waitFor(() => expect(plaidLink.opened).toBe(true));
      plaidLink.fireSuccess('public-sandbox-onboarding');
      await waitFor(() => expect(exchanged).toBe(true));
      await waitFor(() => expect(screen.getByText('First Platypus Bank')).toBeInTheDocument());
    });

    it('surfaces an error if exchange fails after Plaid Link success', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
          HttpResponse.json({
            link_token: 'link-onboarding-3',
            expiration: '2026-05-12T21:00:00Z',
            request_id: 'req-3',
          })
        ),
        http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () =>
          HttpResponse.json({ error: 'INVALID_PUBLIC_TOKEN' }, { status: 502 })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      const bankingButton = within(section('Banking')).getByRole('button');
      await user.click(bankingButton);
      await waitFor(() => expect(plaidLink.opened).toBe(true));
      plaidLink.fireSuccess('public-bad-token');

      await waitFor(() =>
        expect(within(section('Banking')).getByText(/INVALID_PUBLIC_TOKEN/i)).toBeInTheDocument()
      );
    });

    it('shows an error if link-token creation fails', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
          HttpResponse.json({ error: 'Plaid unavailable' }, { status: 502 })
        )
      );
      installOnboardingApiMocks();
      const user = userEvent.setup();
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      const bankingButton = within(section('Banking')).getByRole('button');
      await user.click(bankingButton);

      await waitFor(() =>
        expect(within(section('Banking')).getByText(/plaid unavailable/i)).toBeInTheDocument()
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
      renderWithProviders(<OnboardingData onComplete={() => {}} />);
      await screen.findByText('Connect your Data');

      const bankingButton = within(section('Banking')).getByRole('button');
      await user.click(bankingButton);
      await waitFor(() => expect(plaidLink.opened).toBe(true));

      plaidLink.fireExit({ display_message: 'Bank session aborted' });
      await waitFor(() =>
        expect(within(section('Banking')).getByText(/bank session aborted/i)).toBeInTheDocument()
      );
    });
  });
});
