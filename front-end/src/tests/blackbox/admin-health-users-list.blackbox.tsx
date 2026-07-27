import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import UsersSection from '@/features/admin-health/components/UsersSection';
import type { AdminDirectoryPerson } from '@/lib/adminUsers';

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

function directoryPerson(overrides: Partial<AdminDirectoryPerson> = {}): AdminDirectoryPerson {
  return {
    key: 'user:acct-1',
    userId: 'acct-1',
    waitlistId: 'wl-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+13234498210',
    joinedAt: '2026-07-01T00:00:00.000Z',
    invitedAt: null,
    hasAccount: true,
    hasSubscription: false,
    isGated: true,
    isAdmin: false,
    ...overrides,
  };
}

function directoryResponse(
  people: AdminDirectoryPerson[],
  options: { total?: number; page?: number; pageSize?: number; search?: string } = {},
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
    search: options.search ?? '',
  };
}

describe('UsersSection list', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('lists people with their in-app / waitlist status', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(
          directoryResponse([
            directoryPerson({ key: 'user:acct-1', name: 'Ada Lovelace', isGated: true }),
            directoryPerson({
              key: 'user:acct-2',
              userId: 'acct-2',
              waitlistId: 'wl-2',
              name: 'Alan Turing',
              email: null,
              phone: '+14157915649',
              invitedAt: '2026-07-10T00:00:00.000Z',
            }),
            directoryPerson({
              key: 'user:acct-3',
              userId: 'acct-3',
              waitlistId: null,
              name: 'Grace Hopper',
              email: 'grace@example.com',
              phone: '+12125550188',
              isGated: false,
            }),
          ]),
        ),
      ),
    );

    renderWithProviders(<UsersSection />);

    await waitFor(() => {
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    });
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('+13234498210')).toBeInTheDocument();
    expect(screen.getByText('On waitlist')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    // A user past the gate reads as in-app, not as a waitlist row.
    expect(screen.getByText('In app')).toBeInTheDocument();

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'Name',
      'Email',
      'Phone',
      'Joined',
      'Status',
      'Actions',
    ]);
    expect(screen.getByText((text) => text.startsWith('3 people'))).toBeInTheDocument();
  });

  it('offers a switch action only for rows that resolved to a real account', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(
          directoryResponse([
            directoryPerson({ key: 'user:acct-1', name: 'Ada Lovelace' }),
            // Waitlist-only: no account to step into, so no switch control.
            directoryPerson({
              key: 'waitlist:wl-9',
              userId: null,
              waitlistId: 'wl-9',
              name: 'Not Signed Up',
              hasAccount: false,
              isGated: false,
            }),
          ]),
        ),
      ),
    );

    renderWithProviders(<UsersSection />);

    expect(await screen.findByRole('button', { name: 'Switch to Ada Lovelace' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Switch to Not Signed Up' })).toBeNull();
    // The waitlist-only row can still be invited.
    expect(screen.getAllByRole('button', { name: /Invite, text & email/ })).toHaveLength(2);
  });

  it('searches the directory by name, email, or phone', async () => {
    const searches: string[] = [];
    server.use(
      http.get(`${API_BASE}/admin-health/users`, ({ request }) => {
        const search = new URL(request.url).searchParams.get('search') ?? '';
        searches.push(search);
        const people =
          search === ''
            ? [directoryPerson({ name: 'Ada Lovelace' })]
            : [
                directoryPerson({
                  key: 'user:acct-7',
                  userId: 'acct-7',
                  name: 'Grace Hopper',
                  email: 'grace@example.com',
                }),
              ];
        return HttpResponse.json(directoryResponse(people, { search }));
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'grace');

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    // Debounced: only the settled term reaches the endpoint, not every keystroke.
    expect(searches.at(-1)).toBe('grace');
    expect(searches.filter((term) => term !== '')).toEqual(['grace']);
  });

  it('loads bounded pages and navigates through the directory', async () => {
    const people = [
      directoryPerson({ key: 'user:a', userId: 'a', name: 'First Person' }),
      directoryPerson({ key: 'user:b', userId: 'b', name: 'Second Person' }),
      directoryPerson({ key: 'user:c', userId: 'c', name: 'Third Person' }),
    ];
    server.use(
      http.get(`${API_BASE}/admin-health/users`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const pageSize = 2;
        const start = (page - 1) * pageSize;
        return HttpResponse.json(
          directoryResponse(people.slice(start, start + pageSize), {
            total: people.length,
            page,
            pageSize,
          }),
        );
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

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

  it('surfaces an error when the directory fails to load', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json({ error: 'Failed to load users' }, { status: 500 }),
      ),
    );

    renderWithProviders(<UsersSection />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load users')).toBeInTheDocument();
    });
  });
});
