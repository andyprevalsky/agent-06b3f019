/**
 * Blackbox tests for the Admin Health waitlist-invite flows in UsersSection.
 *
 * Covers:
 *   - invite sends SMS + email, then flips the row off the waitlist
 *   - idempotency key is reused across a retried failure and rotated after success
 *   - a no-account invite outcome is described without claiming the account was flagged
 *
 * The directory listing / search / paging behaviour of the same component lives
 * in admin-health-users-list.blackbox.tsx; the page + fetch layer lives in
 * admin-health.blackbox.tsx.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { Toaster } from '@/components/ui/toaster';
import UsersSection from '@/features/admin-health/components/UsersSection';

import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { API_BASE, directoryPerson, directoryResponse, mockSession } from './admin-health.fixtures';

describe('UsersSection', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('texts and emails an invite, then pulls the person off the waitlist', async () => {
    clearCaptures();
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(directoryResponse([directoryPerson()])),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: true,
          flagged: true,
          alreadyOffWaitlist: false,
          hasAccount: true,
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

    const inviteButton = await screen.findByRole('button', { name: /Invite, text & email/ });
    await user.click(inviteButton);

    await waitFor(() => {
      expect(
        capturedRequests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.includes('/admin-health/waitlist/wl-1/invite') &&
            request.headers.authorization === 'Bearer admin-token',
        ),
      ).toBe(true);
    });

    // Row flips to the invited state and is no longer marked as gated.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-send/ })).toBeInTheDocument();
    });
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.queryByText('On waitlist')).not.toBeInTheDocument();
  });

  it('reuses one idempotency key for a failed attempt and changes it after success', async () => {
    clearCaptures();
    let attempts = 0;
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(directoryResponse([directoryPerson()])),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ error: 'temporary delivery failure' }, { status: 502 });
        }
        return HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: true,
          flagged: true,
          alreadyOffWaitlist: false,
          hasAccount: true,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);
    const inviteButton = await screen.findByRole('button', { name: /Invite, text & email/ });
    await user.click(inviteButton);
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(inviteButton).toBeEnabled());
    await user.click(inviteButton);
    await waitFor(() => expect(attempts).toBe(2));

    const firstTwo = capturedRequests.filter(
      (request) => request.method === 'POST' && request.url.includes('/waitlist/wl-1/invite'),
    );
    expect(firstTwo).toHaveLength(2);
    expect(firstTwo[0].headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(firstTwo[1].headers['idempotency-key']).toBe(firstTwo[0].headers['idempotency-key']);

    await user.click(await screen.findByRole('button', { name: /Re-send/ }));
    await waitFor(() => expect(attempts).toBe(3));
    const allInvites = capturedRequests.filter(
      (request) => request.method === 'POST' && request.url.includes('/waitlist/wl-1/invite'),
    );
    expect(allInvites[2].headers['idempotency-key']).not.toBe(
      allInvites[1].headers['idempotency-key'],
    );
  });

  it('describes a no-account invite outcome without claiming the account was flagged', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(
          directoryResponse([
            directoryPerson({
              userId: null,
              key: 'waitlist:wl-1',
              hasAccount: false,
              isGated: false,
            }),
          ]),
        ),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: false,
          flagged: false,
          alreadyOffWaitlist: false,
          hasAccount: false,
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <UsersSection />
        <Toaster />
      </>,
    );
    await user.click(await screen.findByRole('button', { name: /Invite, text & email/ }));

    expect(await screen.findByText(/no account available to flag/i)).toBeInTheDocument();
    expect(screen.queryByText(/flagged to subscribe/i)).not.toBeInTheDocument();
  });
});
