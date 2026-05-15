/**
 * Blackbox tests for NetworkView.
 *
 * Exercises the LOADING → READY / ERROR states, pagination, sort toggling,
 * and debounced search for the /network table view. The component calls
 * `getPeople()` from `@/lib/api` (re-exported through `../hooks`), which hits
 * `GET /api/people`. We stub MSW handlers per-test to drive the 3 major
 * branches: initial loading → ready, error, and empty results.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

import NetworkView from '@/features/terminal-component-group/components/NetworkView';

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

function makePerson(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `person-${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    email: `p${i}@x.com`,
    phoneNumber: `555-000${i}`,
    messagesExchanged: 10 + i,
    company: `Co ${i}`,
    title: `Title ${i}`,
    communicationFrequency: 'daily',
    ...overrides,
  };
}

function peopleHandler(
  people: Array<ReturnType<typeof makePerson>>,
  pagination: Partial<{ total: number; totalPages: number; page: number; limit: number }> = {},
  onRequest?: (params: URLSearchParams) => void,
) {
  return http.get(`${API_BASE}/people`, ({ request }) => {
    const url = new URL(request.url);
    onRequest?.(url.searchParams);
    return HttpResponse.json({
      people,
      pagination: {
        total: pagination.total ?? people.length,
        totalPages: pagination.totalPages ?? 1,
        page: pagination.page ?? 1,
        limit: pagination.limit ?? 50,
      },
    });
  });
}

describe('NetworkView', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('shows loading state before data arrives', async () => {
    // Respond slowly so we can see the loading state
    server.use(
      http.get(`${API_BASE}/people`, async () => {
        await new Promise((r) => setTimeout(r, 20));
        return HttpResponse.json({
          people: [],
          pagination: { total: 0, totalPages: 1, page: 1, limit: 50 },
        });
      }),
    );
    renderWithProviders(<NetworkView />);
    expect(screen.getByText('Loading network...')).toBeInTheDocument();
    // Let the promise resolve to clean up
    await waitFor(() => {
      expect(screen.queryByText('Loading network...')).not.toBeInTheDocument();
    });
  });

  it('renders READY state with data rows', async () => {
    server.use(peopleHandler([makePerson(1), makePerson(2)], { total: 2, totalPages: 1 }));
    renderWithProviders(<NetworkView />);
    await waitFor(() => {
      expect(screen.getByText('First1')).toBeInTheDocument();
    });
    expect(screen.getByText('Last2')).toBeInTheDocument();
    expect(screen.getByText('2 total')).toBeInTheDocument();
    // Header title
    expect(screen.getByRole('heading', { level: 1, name: /network/i })).toBeInTheDocument();
  });

  it('renders ERROR state when the fetch fails', async () => {
    server.use(http.get(`${API_BASE}/people`, () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<NetworkView />);
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Failed to fetch people/i)).toBeInTheDocument();
  });

  it('renders empty state when there are no contacts', async () => {
    server.use(peopleHandler([], { total: 0, totalPages: 1 }));
    renderWithProviders(<NetworkView />);
    await waitFor(() => {
      expect(screen.getByText(/no people in your network yet/i)).toBeInTheDocument();
    });
    expect(
      screen.getByText(/connect your integrations to start building your network/i),
    ).toBeInTheDocument();
  });

  it('formats null/empty values as an em-dash', async () => {
    server.use(
      peopleHandler(
        [
          makePerson(1, {
            email: null,
            phoneNumber: '',
            company: null,
            title: null,
            communicationFrequency: null,
          }),
        ],
        { total: 1 },
      ),
    );
    renderWithProviders(<NetworkView />);
    await waitFor(() => {
      expect(screen.getByText('First1')).toBeInTheDocument();
    });
    // At least 3 em-dashes (email, phone, company/title/communicationFrequency).
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThanOrEqual(3);
  });

  it('clicking a column header toggles sort asc → desc → unsorted and triggers refetches', async () => {
    const capturedSorts: Array<string | null> = [];
    server.use(
      peopleHandler([makePerson(1)], { total: 1 }, (p) => {
        capturedSorts.push(p.get('sort'));
      }),
    );
    renderWithProviders(<NetworkView />);
    await waitFor(() => expect(screen.getByText('First1')).toBeInTheDocument());

    const user = userEvent.setup();
    // Click "First" header — SortKey 'firstName'. First click: asc.
    await user.click(screen.getByText('First'));
    await waitFor(() => {
      expect(capturedSorts).toContain('firstName');
    });
    // Click again → desc
    await user.click(screen.getByText('First'));
    // Click a third time → unsorted (sort param not set)
    await user.click(screen.getByText('First'));
    // Captured at least the initial + 3 transitions
    expect(capturedSorts.length).toBeGreaterThanOrEqual(4);
    // Final fetch should not include firstName sort (unsorted)
    expect(capturedSorts[capturedSorts.length - 1]).toBeNull();
  });

  it('pagination next/prev buttons advance and retreat the page', async () => {
    const capturedPages: string[] = [];
    server.use(
      peopleHandler([makePerson(1)], { total: 100, totalPages: 3, page: 1 }, (p) => {
        capturedPages.push(p.get('page') ?? '1');
      }),
    );
    renderWithProviders(<NetworkView />);
    await waitFor(() => expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument());

    const user = userEvent.setup();
    // Next page button is the second pagination button; find by chevron-right icon sibling.
    const buttons = screen.getAllByRole('button');
    const prevBtn = buttons.find((b) =>
      b.querySelector('.lucide-chevron-left'),
    ) as HTMLButtonElement;
    const nextBtn = buttons.find((b) =>
      b.querySelector('.lucide-chevron-right'),
    ) as HTMLButtonElement;

    // Prev is disabled on page 1
    expect(prevBtn).toBeDisabled();
    await user.click(nextBtn);
    await waitFor(() => expect(capturedPages).toContain('2'));

    // Now on page 2 — prev should be enabled
    await waitFor(() => {
      expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
    });
    await user.click(prevBtn);
    await waitFor(() => {
      expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
    });
  });

  it('debounced search triggers a fetch with the search param after 300ms', async () => {
    const capturedSearch: Array<string | null> = [];
    server.use(
      peopleHandler([makePerson(1)], { total: 1 }, (p) => {
        capturedSearch.push(p.get('search'));
      }),
    );
    renderWithProviders(<NetworkView />);
    await waitFor(() => expect(screen.getByText('First1')).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/search contacts/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(input, 'alice');

    // Real timers + the hook uses setTimeout(300); wait for a real 400ms.
    await waitFor(
      () => {
        expect(capturedSearch).toContain('alice');
      },
      { timeout: 2000 },
    );
  });

  it('shows "no contacts match your search" when a search returns empty', async () => {
    let callCount = 0;
    server.use(
      http.get(`${API_BASE}/people`, ({ request }) => {
        callCount++;
        const url = new URL(request.url);
        const hasSearch = !!url.searchParams.get('search');
        return HttpResponse.json({
          people: hasSearch ? [] : [makePerson(1)],
          pagination: { total: hasSearch ? 0 : 1, totalPages: 1, page: 1, limit: 50 },
        });
      }),
    );
    renderWithProviders(<NetworkView />);
    await waitFor(() => expect(screen.getByText('First1')).toBeInTheDocument());

    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(/search contacts/i) as HTMLInputElement;
    await user.type(input, 'zzz');

    // Wait for the debounced fetch to produce an empty state
    await waitFor(
      () => {
        expect(screen.getByText(/no contacts match your search/i)).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    expect(callCount).toBeGreaterThan(1);
  });
});
