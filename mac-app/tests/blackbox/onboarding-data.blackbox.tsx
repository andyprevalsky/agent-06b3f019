import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { clearIpcMock, installIpcMock } from './ipc-mock';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import OnboardingData from '../../ui/features/onboarding/components/OnboardingData';
import type { BrowserInfo } from '../../shared/types/ipc';

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
    checkIMessageAccess: vi.fn(async () => true),
    openFullDiskAccessSettings: vi.fn(async () => ({ success: true })),
    startIMessageUpload: vi.fn(async () => ({ success: true })),
    openExternal: vi.fn(async () => ({ success: true })),
    openKeychainAccess: vi.fn(async () => ({ success: true })),
    openPasswordsApp: vi.fn(async () => ({ success: true })),
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
    http.get(`${API_BASE}/user-settings`, () =>
      HttpResponse.json({ onboardingCompletedAt: null, encryptedPaymentInformation: null })
    ),
    http.post(`${API_BASE}/integrations/passwords/request`, () =>
      HttpResponse.json({ success: true })
    ),
    http.post(`${API_BASE}/agents`, () => HttpResponse.json({ id: 'linkedin-agent-1' }))
  );
}

beforeEach(() => {
  localStorage.clear();
  primeSession();
  installBackendMocks();
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
    expect(screen.getByText('Messages Sync')).toBeInTheDocument();
    expect(screen.getByText('Socials')).toBeInTheDocument();
    expect(screen.getByText('Agent Pay')).toBeInTheDocument();
    expect(screen.queryByText('andy@example.com')).not.toBeInTheDocument();

    await user.click(sectionToggle('Messages Sync'));
    expect(screen.getByText('andy@example.com')).toBeInTheDocument();

    const continueButton = screen.getByRole('button', { name: /continue/i });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    expect(onComplete).toHaveBeenCalledTimes(1);
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

    await user.click(sectionToggle('Passwords'));
    const passwords = section('Passwords');
    expect(within(passwords).getByText('Chrome')).toBeInTheDocument();
    expect(within(passwords).getByText('Apple Passwords')).toBeInTheDocument();
    expect(within(passwords).getByText('ChatGPT Atlas')).toBeInTheDocument();

    await user.click(rowAction(passwords, 'Chrome'));
    await waitFor(() => {
      expect(api.syncBrowserPasswords).toHaveBeenCalledWith('chrome');
    });

    await user.click(within(passwords).getByText(/Request one/i));
    await user.type(screen.getByPlaceholderText(/1Password/i), 'Bitwarden');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/Request sent/i)).toBeInTheDocument();

    await user.click(sectionToggle('Messages Sync'));
    const messages = section('Messages Sync');
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
  });
});
