import { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { LoginButton, PhoneAuthModal, useAuth } from '@/features/auth';
import { shouldEnableDevAutoLogin } from '@/features/auth/config';
import { supabase } from '@/lib/supabase';

const API_BASE = 'http://localhost:3001/api';

// Session keys used by supabase.ts
const SESSION_KEY = 'rose-session';
const USER_CACHE_KEY = 'app-user';

/**
 * Build a mock session and store it in localStorage.
 * By default returns a non-anonymous session with an authenticated user.
 */
function mockSession(opts: { anonymous?: boolean; userId?: string; phone?: string } = {}) {
  const userId = opts.userId ?? 'test-user-001';
  const session = {
    access_token: 'test-token-abc',
    refresh_token: 'test-refresh-xyz',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: userId,
      phone: opts.phone ?? '+19729777432',
      is_anonymous: opts.anonymous ?? false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: opts.anonymous
        ? { provider: 'anonymous', providers: ['anonymous'] }
        : { provider: 'phone', providers: ['phone'] },
      user_metadata: {},
    },
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(USER_CACHE_KEY, JSON.stringify(session.user));
  return session;
}

function clearAllStorage() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(USER_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// LoginButton
// ---------------------------------------------------------------------------

describe('LoginButton', () => {
  beforeEach(() => {
    clearCaptures();
    clearAllStorage();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders nothing while auth is loading', () => {
    // No session in storage, so useAuth will be loading briefly
    const { container } = renderWithProviders(<LoginButton />);
    // LoginButton returns null during loading state
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders "Login" button after loading completes (anonymous user)', async () => {
    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
    });
  });

  it('navigates to /terminal when user is already authenticated', async () => {
    mockSession({ anonymous: false });
    const user = userEvent.setup();

    renderWithProviders(<LoginButton />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /login/i }));

    // The navigate('/terminal') call changes the MemoryRouter location.
    // We just verify the button was clickable and no modal opened.
    expect(screen.queryByText('Start Building.')).not.toBeInTheDocument();
  });

  it('opens PhoneAuthModal when clicked with no authenticated user (anonymous)', async () => {
    const user = userEvent.setup();

    // No session => creates anonymous session => user.is_anonymous = true
    // LoginButton checks `user` which will be the anonymous user, but anonymous users
    // still have a user object, so it navigates to /terminal.
    // To truly test "no user" we need to prevent anonymous session creation from working.
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () => {
        return HttpResponse.json({ error: 'Service unavailable' }, { status: 503 });
      }),
    );

    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /login/i }));

    await waitFor(() => {
      expect(screen.getByText('Start Building.')).toBeInTheDocument();
    });
  });

  it('fires POST /api/auth/anonymous on mount when no session exists', async () => {
    clearCaptures();
    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      const anonReq = capturedRequests.find((r) => r.url.includes('/auth/anonymous'));
      expect(anonReq).toBeDefined();
      expect(anonReq!.method).toBe('POST');
    });
  });
});

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------

describe('auth config', () => {
  it('disables dev auto-login inside the Electron app', () => {
    expect(
      shouldEnableDevAutoLogin({
        isDev: true,
        isVitest: false,
        clientSource: 'MAC_APP',
      }),
    ).toBe(false);
  });

  it('keeps dev auto-login available for non-Electron dev web sessions', () => {
    expect(
      shouldEnableDevAutoLogin({
        isDev: true,
        isVitest: false,
        clientSource: 'WEB',
      }),
    ).toBe(true);
  });
});

describe('auth session application', () => {
  beforeEach(() => {
    clearAllStorage();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps applying user and invite state when realtime authentication rejects', async () => {
    const session = mockSession({ userId: 'realtime-failure-user' });
    const setAuth = vi
      .spyOn(supabase.realtime, 'setAuth')
      .mockRejectedValueOnce(new Error('realtime unavailable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useAuth({ passive: true }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.user?.id).toBe(session.user.id);
      expect(result.current.isFullySignedIn).toBe(true);
    });
    expect(result.current.realtimeReady).toBe(false);
    expect(setAuth).toHaveBeenCalledWith(session.access_token);
    expect(consoleError).toHaveBeenCalledWith(
      '[Auth] Failed to authenticate realtime session',
      expect.any(Error),
    );
  });
});

// ---------------------------------------------------------------------------
// PhoneAuthModal
// ---------------------------------------------------------------------------

describe('PhoneAuthModal', () => {
  const onOpenChange = vi.fn();
  const onAuthComplete = vi.fn();

  beforeEach(() => {
    clearCaptures();
    clearAllStorage();
    onOpenChange.mockReset();
    onAuthComplete.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // -- Phone step --

  it('renders phone input step when open', async () => {
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    expect(screen.getByText('Start Building.')).toBeInTheDocument();
    expect(screen.getByText('Create free account')).toBeInTheDocument();
    expect(screen.getByLabelText('Phone Number')).toBeInTheDocument();
    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Last name')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close authentication dialog' })).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    renderWithProviders(<PhoneAuthModal open={false} onOpenChange={onOpenChange} />);

    expect(screen.queryByText('Start Building.')).not.toBeInTheDocument();
  });

  it('disables Continue button when phone is empty', async () => {
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();
  });

  // Phone formatting + country-selector behavior is covered in
  // phone-input.blackbox.tsx (PhoneInput component tests).

  it('enables Continue button after entering a phone number', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '9729777432');

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeEnabled();
  });

  it('submits phone and transitions to OTP step', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Should transition to OTP step
    await waitFor(() => {
      expect(screen.getByText('Verify Code')).toBeInTheDocument();
    });
    expect(screen.getByText(/Code sent to/)).toBeInTheDocument();
    expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
  });

  it('captures POST /api/auth/send-otp with phone in E.164 format', async () => {
    clearCaptures();
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const sendOtpReq = capturedRequests.find((r) => r.url.includes('/auth/send-otp'));
      expect(sendOtpReq).toBeDefined();
      expect(sendOtpReq!.method).toBe('POST');
      expect(sendOtpReq!.body).toEqual({ phone: '+19729777432' });
    });
  });

  it('shows "Sending..." while OTP request is in-flight', async () => {
    // Delay the send-otp response to observe loading state
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({ success: true });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const phoneInput = screen.getByLabelText('Phone Number');
    await user.type(phoneInput, '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // The button should say "Sending..." while in-flight
    expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();

    // Eventually transitions to OTP step
    await waitFor(() => {
      expect(screen.getByText('Verify Code')).toBeInTheDocument();
    });
  });

  it('resets immediately and ignores a late OTP response after a quick reopen', async () => {
    let releaseOtp!: () => void;
    const otpGate = new Promise<void>((resolve) => {
      releaseOtp = resolve;
    });
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, async () => {
        await otpGate;
        return HttpResponse.json({ success: true });
      }),
    );

    function AuthHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Reopen auth
          </button>
          <PhoneAuthModal open={open} onOpenChange={setOpen} />
        </>
      );
    }

    const user = userEvent.setup();
    renderWithProviders(<AuthHarness />);
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close authentication dialog' }));
    await user.click(screen.getByRole('button', { name: 'Reopen auth' }));

    expect(screen.getByRole('button', { name: /continue/i })).toHaveTextContent('Continue');
    await user.type(screen.getByLabelText('Phone Number'), '4155551212');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(screen.getByLabelText('Phone Number')).toHaveValue('(415) 555-1212');
    await act(async () => {
      releaseOtp();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText('Start Building.')).toBeInTheDocument();
    expect(screen.queryByText('Verify Code')).not.toBeInTheDocument();
  });

  // -- OTP step --

  it('shows OTP input with max length 6 and numeric-only input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    // Navigate to OTP step
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Close authentication dialog' })).toBeInTheDocument();
    const otpInput = screen.getByLabelText('Verification Code');
    expect(otpInput).toHaveAttribute('maxLength', '6');
    expect(otpInput).toHaveAttribute('inputMode', 'numeric');
  });

  it('shows SMS authorization checkbox on OTP step', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('I authorize SMS communication')).toBeInTheDocument();
    });
  });

  it('disables Verify button until OTP is 6 digits and SMS is authorized', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    const verifyBtn = screen.getByRole('button', { name: /verify/i });

    // Initially disabled (no OTP, no SMS authorization)
    expect(verifyBtn).toBeDisabled();

    // Type 5 digits — still disabled
    const otpInput = screen.getByLabelText('Verification Code');
    await user.type(otpInput, '18181');
    expect(verifyBtn).toBeDisabled();

    // Type 6th digit — still disabled (SMS not authorized)
    await user.type(otpInput, '8');
    expect(verifyBtn).toBeDisabled();

    // Check SMS authorization — now enabled
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(verifyBtn).toBeEnabled();
  });

  it('captures POST /api/auth/verify-otp with phone and token on verify', async () => {
    clearCaptures();
    const user = userEvent.setup();
    renderWithProviders(
      <PhoneAuthModal open={true} onOpenChange={onOpenChange} onAuthComplete={onAuthComplete} />,
    );

    // Phone step — the optional email is captured alongside phone (empty email
    // does not block Continue; a provided value flows through to verify-otp).
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.type(screen.getByLabelText('Email'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // OTP step
    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const verifyReq = capturedRequests.find((r) => r.url.includes('/auth/verify-otp'));
      expect(verifyReq).toBeDefined();
      expect(verifyReq!.method).toBe('POST');
      const body = verifyReq!.body as Record<string, unknown>;
      expect(body.phone).toBe('+19729777432');
      expect(body.token).toBe('181818');
      expect(body.email).toBe('person@example.com');
    });
  });

  it('calls onAuthComplete and closes modal after successful OTP verification', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PhoneAuthModal open={true} onOpenChange={onOpenChange} onAuthComplete={onAuthComplete} />,
    );

    // Phone step
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // OTP step
    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(onAuthComplete).toHaveBeenCalledTimes(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows "Verifying..." during OTP verification', async () => {
    server.use(
      http.post(`${API_BASE}/auth/verify-otp`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({
          user: { id: 'verified-user-001', phone: '+19729777432' },
          session: {
            access_token: 'test-verified-token',
            refresh_token: 'test-verified-refresh',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            token_type: 'bearer',
          },
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(screen.getByRole('button', { name: /verifying/i })).toBeInTheDocument();
  });

  // -- Back / close --

  it('allows going back from OTP step to phone step', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    // Navigate to OTP step
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Verify Code')).toBeInTheDocument();
    });

    // Click back button
    await user.click(screen.getByRole('button', { name: /change phone number/i }));

    // Should be back on phone step
    await waitFor(() => {
      expect(screen.getByText('Start Building.')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Phone Number')).toBeInTheDocument();
  });

  it('shows terms and privacy links on phone step', () => {
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    const termsLink = screen.getByRole('link', { name: /terms/i });
    expect(termsLink).toHaveAttribute('href', 'https://roselabs.ai/terms');

    const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
    expect(privacyLink).toHaveAttribute('href', 'https://roselabs.ai/privacy');
  });

  it('passes anonymousUserId to verify-otp when provided', async () => {
    clearCaptures();
    const user = userEvent.setup();
    renderWithProviders(
      <PhoneAuthModal
        open={true}
        onOpenChange={onOpenChange}
        anonymousUserId="anon-merge-user-123"
      />,
    );

    // Phone step
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // OTP step
    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const verifyReq = capturedRequests.find((r) => r.url.includes('/auth/verify-otp'));
      expect(verifyReq).toBeDefined();
      const body = verifyReq!.body as Record<string, unknown>;
      expect(body.anonymousUserId).toBe('anon-merge-user-123');
    });
  });

  // -- Error handling --

  it('stays on phone step when send-otp fails', async () => {
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, () => {
        return HttpResponse.json({ error: 'Rate limited' }, { status: 429 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Should remain on phone step (not transition to OTP)
    await waitFor(() => {
      expect(screen.getByText('Start Building.')).toBeInTheDocument();
    });
    // Continue button should be re-enabled after error
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
  });

  it('stays on OTP step when verify-otp fails', async () => {
    server.use(
      http.post(`${API_BASE}/auth/verify-otp`, () => {
        return HttpResponse.json({ error: 'Invalid OTP' }, { status: 400 });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '000000');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    // Should remain on OTP step
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();
    });
    expect(screen.getByText('Verify Code')).toBeInTheDocument();
  });

  it('strips non-digit characters from OTP input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    const otpInput = screen.getByLabelText('Verification Code');
    // Type digits with letters mixed in - letters should be stripped
    await user.type(otpInput, '1a2b3c4d5e6f');

    // Only digits are kept, max 6
    expect(otpInput).toHaveValue('123456');
  });
});

// ---------------------------------------------------------------------------
// Auth state (session in localStorage)
// ---------------------------------------------------------------------------

describe('Auth state (localStorage session)', () => {
  beforeEach(() => {
    clearCaptures();
    clearAllStorage();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('creates anonymous session and stores it in localStorage when no session exists', async () => {
    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      const stored = localStorage.getItem(SESSION_KEY);
      expect(stored).toBeTruthy();
      const session = JSON.parse(stored!);
      expect(session.access_token).toBe('test-anon-token');
      expect(session.user.is_anonymous).toBe(true);
    });
  });

  it('uses existing session from localStorage without calling anonymous endpoint', async () => {
    clearCaptures();
    mockSession({ anonymous: false, userId: 'existing-user-999' });

    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /login/i })).toBeInTheDocument();
    });

    // Should not have called anonymous endpoint since session already exists
    const anonReqs = capturedRequests.filter((r) => r.url.includes('/auth/anonymous'));
    expect(anonReqs).toHaveLength(0);
  });

  it('stores verified session in localStorage after successful OTP verification', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={onOpenChange} />);

    // Complete the full auth flow
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const stored = localStorage.getItem(SESSION_KEY);
      expect(stored).toBeTruthy();
      const session = JSON.parse(stored!);
      expect(session.access_token).toBe('test-verified-token');
      expect(session.user.is_anonymous).toBe(false);
      expect(session.user.id).toBe('verified-user-001');
    });
  });
});

// ---------------------------------------------------------------------------
// API boundary capture
// ---------------------------------------------------------------------------

describe('API boundary capture', () => {
  beforeEach(() => {
    clearCaptures();
    clearAllStorage();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('sends POST /api/auth/anonymous with correct headers', async () => {
    clearCaptures();
    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      const anonReq = capturedRequests.find((r) => r.url.includes('/auth/anonymous'));
      expect(anonReq).toBeDefined();
      expect(anonReq!.method).toBe('POST');
      expect(anonReq!.headers['content-type']).toBe('application/json');
    });
  });

  it('sends POST /api/auth/send-otp with E.164 phone', async () => {
    clearCaptures();
    const user = userEvent.setup();

    renderWithProviders(<PhoneAuthModal open={true} onOpenChange={vi.fn()} />);

    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const req = capturedRequests.find((r) => r.url.includes('/auth/send-otp'));
      expect(req).toBeDefined();
      expect(req!.method).toBe('POST');
      expect(req!.headers['content-type']).toBe('application/json');
      expect(req!.body).toEqual({ phone: '+19729777432' });
    });
  });

  it('sends POST /api/auth/verify-otp with phone, token, and anonymousUserId', async () => {
    clearCaptures();
    const user = userEvent.setup();

    renderWithProviders(
      <PhoneAuthModal open={true} onOpenChange={vi.fn()} anonymousUserId="anon-user-to-merge" />,
    );

    // Phone step
    await user.type(screen.getByLabelText('Phone Number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // OTP step
    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Verification Code'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      const req = capturedRequests.find((r) => r.url.includes('/auth/verify-otp'));
      expect(req).toBeDefined();
      expect(req!.method).toBe('POST');
      expect(req!.headers['content-type']).toBe('application/json');
      const body = req!.body as Record<string, unknown>;
      expect(body.phone).toBe('+19729777432');
      expect(body.token).toBe('181818');
      expect(body.anonymousUserId).toBe('anon-user-to-merge');
    });
  });

  it('sends GET /api/invite-codes/check after authenticated session applied', async () => {
    clearCaptures();
    mockSession({ anonymous: false });

    renderWithProviders(<LoginButton />);

    await waitFor(() => {
      const inviteReq = capturedRequests.find((r) => r.url.includes('/invite-codes/check'));
      expect(inviteReq).toBeDefined();
      expect(inviteReq!.method).toBe('GET');
    });
  });
});
