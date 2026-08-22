/**
 * Mac app relay offline chip — integrations row + global web badge.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import MessagesSyncSection from '@/features/integrations/components/MessagesSyncSection';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import { useMacAppRelayStatus } from '@/features/integrations/hooks/useMacAppRelayStatus';
import { fetchImessageBridgeStatusApi } from '@/features/integrations/api';
import { API_BASE_WITH_PATH } from '@/features/integrations/config';
import { TopRightControls } from '@/components/TopRightControls';
import { MacAppOfflineBadge } from '@/features/terminal/components/MacAppOfflineBadge';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = API_BASE_WITH_PATH;

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

function bridgeStatusHandler(connected: boolean) {
  return http.get(`${API_BASE}/imessage/bridge/status`, () =>
    HttpResponse.json({
      connected,
      last_seen_at: connected ? new Date().toISOString() : '2026-01-01T00:00:00.000Z',
    }),
  );
}

function plaidItemsHandler() {
  return http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] }));
}

const iMessageHandlers = {
  iMessage: {
    isAvailable: true,
    onClick: vi.fn(async () => {}),
  },
};

const messagesSectionProps = {
  expanded: true,
  onToggle: () => {},
  isIMessageAvailable: true,
  isWhatsAppAvailable: false,
  iMessageSynced: true,
  whatsAppConnected: false,
  messageSyncLoading: null,
  onIMessageSync: () => {},
  onWhatsAppConnect: () => {},
  connectedIntegrations: [],
  connectingProvider: null,
  disconnectingEmail: null,
  resyncingEmail: null,
  onGmailConnect: () => {},
  onGmailDisconnect: () => {},
  onGmailResync: () => {},
} as const;

describe('Mac app offline chip', () => {
  beforeEach(() => {
    mockSession();
    server.use(integrationsHandler(), plaidItemsHandler());
    vi.stubGlobal('api', undefined);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('renders an offline chip beside iMessage when the relay is stale', () => {
    renderWithProviders(
      <MessagesSyncSection {...messagesSectionProps} macAppRelayOffline={true} />,
    );

    expect(screen.getByText('Mac app offline')).toBeInTheDocument();
  });

  it('omits the offline chip when the relay is connected', () => {
    renderWithProviders(
      <MessagesSyncSection {...messagesSectionProps} macAppRelayOffline={false} />,
    );

    expect(screen.queryByText('Mac app offline')).not.toBeInTheDocument();
  });

  it('fetches bridge status through the integrations API client', async () => {
    server.use(bridgeStatusHandler(false));

    const out = await fetchImessageBridgeStatusApi();
    expect(out).toEqual({
      connected: false,
      last_seen_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('polls the Mac relay bridge status while enabled', async () => {
    server.use(bridgeStatusHandler(false));

    const { result } = renderHook(() => useMacAppRelayStatus(true));

    await waitFor(() => {
      expect(result.current).toEqual({
        connected: false,
        last_seen_at: '2026-01-01T00:00:00.000Z',
      });
    });
  });

  it('wires relay status through the integrations page when iMessage is synced', async () => {
    const user = userEvent.setup();
    server.use(
      integrationsHandler([
        { id: 'int-imessage', name: 'imessage', status: 'CONNECTED', isActive: true },
      ]),
      bridgeStatusHandler(false),
    );

    renderWithProviders(
      <IntegrationHandlersProvider handlers={iMessageHandlers}>
        <Integrations />
      </IntegrationHandlersProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Messages')).toBeInTheDocument();
    });

    const messagesSection = screen.getByText('Messages').closest('.rounded-lg')!;
    await user.click(within(messagesSection as HTMLElement).getAllByRole('button')[0]);

    await waitFor(() => {
      const row = screen.getByText('iMessage').closest('div.px-4') as HTMLElement;
      expect(within(row).getByText('Mac app offline')).toBeInTheDocument();
    });
  });

  it('portals a global offline badge on web when iMessage is synced and relay is stale', async () => {
    server.use(
      integrationsHandler([
        { id: 'int-imessage', name: 'imessage', status: 'CONNECTED', isActive: true },
      ]),
      bridgeStatusHandler(false),
    );

    renderWithProviders(
      <>
        <TopRightControls>
          <div data-testid="admin-slot" />
        </TopRightControls>
        <MacAppOfflineBadge />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('mac-app-offline-badge')).toBeInTheDocument();
    });
    expect(screen.getByText('Mac app offline')).toBeInTheDocument();
  });
});
