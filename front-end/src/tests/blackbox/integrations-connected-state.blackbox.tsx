/**
 * Connected-state treatment across the Integrations panel.
 *
 * Two regressions this suite pins:
 *
 * 1. The rose "Connected" label shipped only on SECTION headers
 *    (SectionToggleButton). Individual rows inside an expanded section
 *    (Chrome, ChatGPT Atlas, iMessage, ...) rendered the synced rose icon
 *    glow but no textual state, so a connected row was indistinguishable
 *    from an unconnected one for anyone not parsing the glow.
 *
 * 2. WhatsApp had exactly two states -- CONNECTED, or "Desktop Only" +
 *    "Download for Mac". There was no desktop-available-but-unconnected
 *    state, so the Mac app itself advertised "Download for Mac".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import { useMessagesSync } from '@/features/integrations/hooks/useMessagesSync';
import type { IntegrationHandlers } from '@/features/integration-handlers-context';

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

function integrationsHandler(integrations: unknown[] = []) {
  return http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations }));
}

function browserHandlers(): IntegrationHandlers {
  return {
    browserCookies: {
      isAvailable: true,
      getInstalledBrowsers: vi.fn(async () => [
        { type: 'chrome' as const, name: 'Chrome', isInstalled: true, needsManualPassword: false },
      ]),
      syncBrowser: vi.fn(async () => {}),
      syncBrowserPasswords: vi.fn(async () => ({ success: true })),
      storeAtlasPassword: vi.fn(async () => ({ success: true })),
      openKeychainAccess: vi.fn(async () => ({ success: true })),
    },
  };
}

async function expandSection(user: ReturnType<typeof userEvent.setup>, title: string) {
  await waitFor(() => {
    expect(screen.getByText(title)).toBeInTheDocument();
  });
  const section = screen.getByText(title).closest('.rounded-lg')!;
  const toggle = within(section as HTMLElement).getAllByRole('button')[0];
  await user.click(toggle);
  return section as HTMLElement;
}

function rowFor(label: string): HTMLElement {
  return screen.getByText(label).closest('div.px-4') as HTMLElement;
}

describe('Integrations connected-state treatment', () => {
  beforeEach(() => {
    mockSession();
    server.use(integrationsHandler());
  });

  afterEach(() => {
    localStorage.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Per-row "Connected" label
  // -------------------------------------------------------------------------

  describe('per-row Connected label', () => {
    it('labels a synced browser row Connected, not just the section header', async () => {
      const user = userEvent.setup();
      server.use(
        integrationsHandler([
          { id: 'int-chrome', name: 'chrome', status: 'CONNECTED', isActive: true },
        ]),
      );

      renderWithProviders(
        <IntegrationHandlersProvider handlers={browserHandlers()}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Browser Cookies');

      await waitFor(() => {
        expect(screen.getByText('Chrome')).toBeInTheDocument();
      });

      // The row itself -- not merely the section header -- must say Connected.
      expect(within(rowFor('Chrome')).getByText('Connected')).toBeInTheDocument();
    });

    it('leaves an unsynced row without a Connected label', async () => {
      const user = userEvent.setup();

      renderWithProviders(
        <IntegrationHandlersProvider handlers={browserHandlers()}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Browser Cookies');

      await waitFor(() => {
        expect(screen.getByText('Chrome')).toBeInTheDocument();
      });

      expect(within(rowFor('Chrome')).queryByText('Connected')).not.toBeInTheDocument();
    });

    it('labels a synced password row Connected', async () => {
      const user = userEvent.setup();
      server.use(
        integrationsHandler([
          { id: 'int-atlas', name: 'atlas_passwords', status: 'CONNECTED', isActive: true },
        ]),
      );

      renderWithProviders(
        <IntegrationHandlersProvider handlers={browserHandlers()}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Passwords');

      await waitFor(() => {
        expect(screen.getByText('ChatGPT Atlas')).toBeInTheDocument();
      });

      expect(within(rowFor('ChatGPT Atlas')).getByText('Connected')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 2. WhatsApp desktop-available state
  // -------------------------------------------------------------------------

  describe('WhatsApp row', () => {
    it('offers a connect action -- not "Download for Mac" -- when the desktop handler exists', async () => {
      const user = userEvent.setup();
      const handlers: IntegrationHandlers = {
        ...browserHandlers(),
        whatsApp: {
          isAvailable: true,
          connect: vi.fn(async () => ({ success: true })),
        },
      };

      renderWithProviders(
        <IntegrationHandlersProvider handlers={handlers}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Messages');

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      const row = rowFor('WhatsApp');
      // The Mac app must never tell you to download the Mac app.
      expect(within(row).queryByText('Download for Mac')).not.toBeInTheDocument();
      expect(within(row).queryByText('Desktop Only')).not.toBeInTheDocument();
      expect(within(row).getByRole('button', { name: /connect whatsapp/i })).toBeInTheDocument();
    });

    it('invokes the desktop connect handler when the row action is clicked', async () => {
      const user = userEvent.setup();
      const connect = vi.fn(async () => ({ success: true }));
      const handlers: IntegrationHandlers = {
        ...browserHandlers(),
        whatsApp: { isAvailable: true, connect },
      };

      renderWithProviders(
        <IntegrationHandlersProvider handlers={handlers}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Messages');

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      await user.click(
        within(rowFor('WhatsApp')).getByRole('button', { name: /connect whatsapp/i }),
      );

      await waitFor(() => {
        expect(connect).toHaveBeenCalledTimes(1);
      });
    });

    it('still shows the download fallback on web, where no desktop handler exists', async () => {
      const user = userEvent.setup();

      renderWithProviders(<Integrations />);

      await expandSection(user, 'Messages');

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      const row = rowFor('WhatsApp');
      expect(within(row).getByText('Desktop Only')).toBeInTheDocument();
      expect(within(row).getByRole('link', { name: /download for mac/i })).toBeInTheDocument();
    });

    it('shows Synced and no connect action once WhatsApp is connected', async () => {
      const user = userEvent.setup();
      server.use(
        integrationsHandler([
          { id: 'int-wa', name: 'whatsapp', status: 'CONNECTED', isActive: true },
        ]),
      );
      const handlers: IntegrationHandlers = {
        ...browserHandlers(),
        whatsApp: { isAvailable: true, connect: vi.fn(async () => ({ success: true })) },
      };

      renderWithProviders(
        <IntegrationHandlersProvider handlers={handlers}>
          <Integrations />
        </IntegrationHandlersProvider>,
      );

      await expandSection(user, 'Messages');

      await waitFor(() => {
        expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      });

      const row = rowFor('WhatsApp');
      expect(within(row).getByText('Synced')).toBeInTheDocument();
      expect(within(row).queryByText('Download for Mac')).not.toBeInTheDocument();
      expect(
        within(row).queryByRole('button', { name: /connect whatsapp/i }),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Message operations share one loading slot
  // -------------------------------------------------------------------------

  describe('message sync serialization', () => {
    // iMessage and WhatsApp both drive `messageSyncLoading`. Started together,
    // the second overwrote the first's label and the first `finally` cleared the
    // row while the other native operation was still running -- re-exposing the
    // action mid-flight and allowing a duplicate native call.
    it('refuses a second message operation while one is in flight', async () => {
      let releaseIMessage: (() => void) | undefined;
      const iMessageClick = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseIMessage = resolve;
          }),
      );
      const whatsAppConnect = vi.fn(async () => ({ success: true }));
      const handlers = {
        iMessage: { isAvailable: true, onClick: iMessageClick },
        whatsApp: { isAvailable: true, connect: whatsAppConnect },
      } as unknown as Parameters<typeof useMessagesSync>[0];

      const { result } = renderHook(() => useMessagesSync(handlers, async () => {}, null));

      let iMessagePending: Promise<void> | undefined;
      act(() => {
        iMessagePending = result.current.handleIMessageSync();
      });
      await waitFor(() => {
        expect(result.current.messageSyncLoading).toBe('imessage');
      });

      // WhatsApp must not start, and must not steal the loading label.
      await act(async () => {
        await result.current.handleWhatsAppConnect();
      });
      expect(whatsAppConnect).not.toHaveBeenCalled();
      expect(result.current.messageSyncLoading).toBe('imessage');

      await act(async () => {
        releaseIMessage!();
        await iMessagePending;
      });
      expect(result.current.messageSyncLoading).toBeNull();

      // Once settled, the next operation is allowed.
      await act(async () => {
        await result.current.handleWhatsAppConnect();
      });
      expect(whatsAppConnect).toHaveBeenCalledTimes(1);
    });
  });
});
