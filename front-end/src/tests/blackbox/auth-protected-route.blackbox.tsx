import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtectedRoute } from '@/features/auth';

import { clearCaptures } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';
const USER_CACHE_KEY = 'app-user';

function storeSession(anonymous: boolean) {
  const session = {
    access_token: 'test-token-abc',
    refresh_token: 'test-refresh-xyz',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: 'protected-route-user',
      phone: '+19729777432',
      is_anonymous: anonymous,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: anonymous
        ? { provider: 'anonymous', providers: ['anonymous'] }
        : { provider: 'phone', providers: ['phone'] },
      user_metadata: {},
    },
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(USER_CACHE_KEY, JSON.stringify(session.user));
}

describe('ProtectedRoute', () => {
  beforeEach(() => {
    clearCaptures();
    localStorage.clear();
  });

  afterEach(() => localStorage.clear());

  it('shows loading spinner while auth is being checked', () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return HttpResponse.json({ user: { id: 'delayed-anonymous-user' } });
      }),
    );

    renderWithProviders(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>,
    );

    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  for (const anonymous of [false, true]) {
    it(`renders children for an ${anonymous ? 'anonymous' : 'authenticated'} user`, async () => {
      storeSession(anonymous);
      renderWithProviders(
        <ProtectedRoute>
          <div>Protected content</div>
        </ProtectedRoute>,
      );
      await waitFor(() => expect(screen.getByText('Protected content')).toBeInTheDocument());
    });
  }

  it('does not render children when anonymous session creation fails', async () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () =>
        HttpResponse.json({ error: 'Service unavailable' }, { status: 503 }),
      ),
    );
    renderWithProviders(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>,
    );

    await waitFor(() => expect(document.querySelector('.animate-spin')).not.toBeInTheDocument());
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});
