import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import WaitlistPeopleSection from '@/features/admin-health/components/WaitlistPeopleSection';
import type { AdminWaitlistPerson } from '@/features/admin-health/types';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'admin-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: '1f85ff25-6e29-4c1b-8739-f917bd101a30' },
    }),
  );
}

function waitlistPerson(overrides: Partial<AdminWaitlistPerson> = {}): AdminWaitlistPerson {
  return {
    id: 'wl-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+13234498210',
    variant: 'gated-login',
    joinedAt: '2026-07-01T00:00:00.000Z',
    invitedAt: null,
    hasAccount: true,
    isGated: true,
    ...overrides,
  };
}

function waitlistResponse(
  people: AdminWaitlistPerson[],
  options: { total?: number; page?: number; pageSize?: number } = {},
) {
  const total = options.total ?? people.length;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  return {
    people,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

describe('WaitlistPeopleSection list', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('lists the waitlist people with their gate status', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/waitlist`, () =>
        HttpResponse.json(
          waitlistResponse([
            waitlistPerson({ id: 'wl-1', name: 'Ada Lovelace', isGated: true }),
            {
              ...waitlistPerson({
                id: 'wl-2',
                name: 'Alan Turing',
                phone: '+14157915649',
                invitedAt: '2026-07-10T00:00:00.000Z',
              }),
              email: null,
            },
          ]),
        ),
      ),
    );

    renderWithProviders(<WaitlistPeopleSection />);

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    });
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('+13234498210')).toBeInTheDocument();
    expect(screen.getByText('On waitlist')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Name',
      'Email',
      'Phone',
      'Joined',
      'Status',
      'Action',
    ]);
    expect(screen.getByText((text) => text.startsWith('2 on the waitlist'))).toBeInTheDocument();
  });

  it('loads bounded pages and navigates through the waitlist', async () => {
    const people = [
      waitlistPerson({ id: 'wl-1', name: 'First Person' }),
      waitlistPerson({ id: 'wl-2', name: 'Second Person' }),
      waitlistPerson({ id: 'wl-3', name: 'Third Person' }),
    ];
    server.use(
      http.get(`${API_BASE}/admin-health/waitlist`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const pageSize = 2;
        const start = (page - 1) * pageSize;
        return HttpResponse.json(
          waitlistResponse(people.slice(start, start + pageSize), {
            total: people.length,
            page,
            pageSize,
          }),
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<WaitlistPeopleSection />);

    expect(await screen.findByText('First Person')).toBeInTheDocument();
    expect(screen.getByText('Second Person')).toBeInTheDocument();
    expect(screen.queryByText('Third Person')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next page' }));

    expect(await screen.findByText('Third Person')).toBeInTheDocument();
    expect(screen.queryByText('First Person')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 3–3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeEnabled();
  });

  it('surfaces an error when the waitlist list fails to load', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/waitlist`, () =>
        HttpResponse.json({ error: 'Failed to load waitlist' }, { status: 500 }),
      ),
    );

    renderWithProviders(<WaitlistPeopleSection />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load waitlist')).toBeInTheDocument();
    });
  });
});
