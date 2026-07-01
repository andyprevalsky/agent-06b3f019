// Workers APPEND their domain's backend endpoints here. Each handler returns a
// realistic happy-path response; individual tests override with `server.use(...)`
// for errors or edge cases. Do not remove or reorder — only append.
//
// When adding handlers, import `http` and `HttpResponse` from 'msw' at that time.

import { http, HttpResponse, type RequestHandler } from 'msw';

const BACKEND_URL = 'http://localhost:3001';

export const handlers: RequestHandler[] = [
  // workers append here

  // --- renderer-main domain (owner: andyprevalsky/blackbox-renderer-main) ---
  // Default happy-path for onboarding-gate reads. Individual tests override
  // with server.use(...) to exercise empty/error branches.
  http.get(`${BACKEND_URL}/api/user-settings`, () =>
    HttpResponse.json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' })
  ),
  http.post(`${BACKEND_URL}/api/auth/complete-onboarding`, () =>
    HttpResponse.json({ success: true })
  ),

  // --- onboarding domain (owner: andyprevalsky/blackbox-onboarding) ---
  http.post(`${BACKEND_URL}/api/auth/send-otp`, () => HttpResponse.json({ success: true })),
  http.post(`${BACKEND_URL}/api/auth/verify-otp`, () =>
    HttpResponse.json({
      user: { id: 'onboarding-user-001', phone: '+19729777432' },
      session: {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: 'bearer',
      },
    })
  ),

  // --- onboarding-customization domain (owner: andyprevalsky/blackbox-onboarding) ---
  // Default happy-path PATCH for saving customization settings. Tests
  // override per-case for failure modes.
  http.patch(`${BACKEND_URL}/api/user-settings`, () => HttpResponse.json({ success: true })),
];
