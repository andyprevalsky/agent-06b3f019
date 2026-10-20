import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';

const API_BASE = 'http://localhost:3001/api';

/**
 * A connected integration whose accounts have diverged in health.
 *
 * Before per-account health existed, this shape was indistinguishable from a
 * fully healthy one: the whole row rendered a single rose "Connected" chip, and
 * a revoked account stayed invisible until someone noticed their email had
 * stopped syncing weeks later.
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

describe('Integrations page', () => {
  beforeEach(() => {
    mockSession();
    server.use(http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations: [] })));
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('damaged Gmail account', () => {
    /** One healthy account and one with a revoked grant, as the API now reports it. */
    const damagedGmail = () => [
      {
        id: 'int-gmail',
        name: 'gmail',
        status: 'CONNECTED',
        isActive: true,
        config: {
          connectedEmail: 'healthy@gmail.com',
          connectedEmails: ['healthy@gmail.com', 'broken@gmail.com'],
        },
        emailCredentials: [
          { id: 'c1', email: 'healthy@gmail.com', state: 'connected', lastErrorReason: null },
          {
            id: 'c2',
            email: 'broken@gmail.com',
            state: 'needs_reconnect',
            lastErrorReason: 'Access was revoked or expired.',
          },
        ],
      },
    ];

    const expandMessages = async (user: ReturnType<typeof userEvent.setup>) => {
      await waitFor(() => expect(screen.getByText('Messages')).toBeInTheDocument());
      const section = screen.getByText('Messages').closest<HTMLElement>('.rounded-lg')!;
      await user.click(within(section).getAllByRole('button')[0]);
    };

    it('marks only the damaged account, and says the section needs reconnection', async () => {
      const user = userEvent.setup();
      server.use(
        http.get(`${API_BASE}/integrations`, () =>
          HttpResponse.json({ integrations: damagedGmail() }),
        ),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });

      // The header must stop claiming "Connected" while an account is broken —
      // that mislabel is what hid a dead account for five weeks.
      await waitFor(() => {
        expect(screen.getByText('Needs Reconnection')).toBeInTheDocument();
      });

      await expandMessages(user);

      const broken = await screen.findByText('broken@gmail.com');
      expect(broken.parentElement).toHaveClass('bg-amber-500/10');

      // The healthy account keeps the rose treatment.
      const healthy = screen.getByText('healthy@gmail.com');
      expect(healthy.parentElement).toHaveClass('bg-rose-500/10');
      expect(healthy.parentElement).not.toHaveClass('bg-amber-500/10');
    });

    it('repairs a transient failure in place, without an OAuth redirect', async () => {
      const user = userEvent.setup();
      let resyncedEmail: string | null = null;
      let oauthStarts = 0;
      const integrations = damagedGmail();

      server.use(
        http.get(`${API_BASE}/integrations`, () => HttpResponse.json({ integrations })),
        http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
          oauthStarts += 1;
          return HttpResponse.json({ authUrl: 'https://accounts.google.com/oauth/test' });
        }),
        http.post(`${API_BASE}/integrations/email/gmail/accounts/:email/resync`, ({ params }) => {
          resyncedEmail = decodeURIComponent(String(params.email));
          // Server repaired it inline; no re-consent needed.
          integrations[0].emailCredentials[1] = {
            id: 'c2',
            email: 'broken@gmail.com',
            state: 'connected',
            lastErrorReason: null,
          };
          return HttpResponse.json({
            email: resyncedEmail,
            needsReauth: false,
            state: 'connected',
            reason: null,
          });
        }),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });
      await expandMessages(user);

      const resync = await screen.findByRole('button', { name: /reconnect broken@gmail.com/i });
      await user.click(resync);

      await waitFor(() => expect(resyncedEmail).toBe('broken@gmail.com'));
      // A transient failure must NOT drag the user through OAuth.
      expect(oauthStarts).toBe(0);

      await waitFor(() => {
        expect(screen.getByText('broken@gmail.com').parentElement).toHaveClass('bg-rose-500/10');
      });
    });

    it('falls back to the OAuth flow when the grant is revoked', async () => {
      const user = userEvent.setup();
      let oauthStarts = 0;

      server.use(
        http.get(`${API_BASE}/integrations`, () =>
          HttpResponse.json({ integrations: damagedGmail() }),
        ),
        http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
          oauthStarts += 1;
          return HttpResponse.json({ authUrl: 'https://accounts.google.com/oauth/test' });
        }),
        http.post(`${API_BASE}/integrations/email/gmail/accounts/:email/resync`, ({ params }) =>
          HttpResponse.json({
            email: decodeURIComponent(String(params.email)),
            needsReauth: true,
            state: 'needs_reconnect',
            reason: 'Access was revoked or expired.',
          }),
        ),
      );

      renderWithProviders(<Integrations />, { roseDesktop: false });
      await expandMessages(user);

      const resync = await screen.findByRole('button', { name: /reconnect broken@gmail.com/i });
      await user.click(resync);

      // Retrying cannot fix a revoked grant, so the chip must hand off to OAuth.
      await waitFor(() => expect(oauthStarts).toBe(1));
    });
  });
});
