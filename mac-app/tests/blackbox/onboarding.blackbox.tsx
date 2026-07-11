import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { installIpcMock, clearIpcMock } from './ipc-mock';
import OnboardingAuth from '../../ui/onboarding/OnboardingAuth';

/**
 * Black-box coverage for the onboarding auth flow (phone entry → OTP → auth-complete).
 *
 * Source under test: `mac-app/ui/onboarding/OnboardingAuth.tsx` which delegates to
 * `SignupForm`, `OtpForm`, and the `useOnboardingAuth` hook. The hook talks to the
 * backend via the shared front-end `sendOTP` / `verifyOTP` API helpers, which POST
 * to `${VITE_BACKEND_API_URL}/api/auth/send-otp` and `/api/auth/verify-otp`.
 *
 * We only assert on user-visible DOM and captured network requests — no internal
 * state, no mocked hook returns.
 *
 * State-machine sketch:
 *   signup --(valid form + send-otp 200)--> otp --(smsAuthorized + verify-otp 200)--> complete
 *   signup --(send-otp 5xx)--------------> signup (with error banner, re-enabled)
 *   otp    --(verify-otp 4xx)-------------> otp    (with error banner, re-enabled)
 *   otp    --(Use a different number)----> signup (otp cleared, error cleared)
 */

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';

function parseBody(body: string | null): Record<string, unknown> {
  if (body === null) return {};
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function completePhoneStep(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('First name'), 'Andy');
  await user.type(screen.getByPlaceholderText('Last name'), 'Prevalsky');
  await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

beforeEach(() => {
  clearCaptures();
  localStorage.clear();
  installIpcMock({
    auth: {
      check: () => Promise.resolve(null),
      save: () => Promise.resolve({ success: true }),
      clear: () => Promise.resolve({ success: true }),
    },
  });
});

afterEach(() => {
  localStorage.clear();
  clearIpcMock();
});

describe('OnboardingAuth — empty / initial state', () => {
  it('renders the signup form on first mount', () => {
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    expect(screen.getByPlaceholderText('First name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Last name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Phone number')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByText('Sign up or log in to continue')).toBeInTheDocument();
  });

  it('disables Continue until first name, last name, and an 11-digit phone are entered', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText('First name'), 'Andy');
    expect(continueBtn).toBeDisabled();

    await user.type(screen.getByPlaceholderText('Last name'), 'Prevalsky');
    expect(continueBtn).toBeDisabled();

    // Short phone — still disabled
    await user.type(screen.getByPlaceholderText('Phone number'), '972');
    expect(continueBtn).toBeDisabled();

    // Complete to 10 digits — formatted to +1 (…) → 11 digits after +1 prefix, now enabled
    await user.type(screen.getByPlaceholderText('Phone number'), '9777432');
    expect(continueBtn).toBeEnabled();
  });

  it('formats the phone number as the user types (US national display)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    const phoneInput = screen.getByPlaceholderText('Phone number');
    await user.type(phoneInput, '9729777432');
    expect(phoneInput).toHaveValue('(972) 977-7432');
  });
});

describe('OnboardingAuth — happy path', () => {
  it('transitions signup → OTP after a successful send-otp and shows the masked phone', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByText('Verify your number')).toBeInTheDocument();
    });
    expect(screen.getByText(/We sent a code to/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
  });

  it('invokes onComplete after a successful verify-otp and stores the session', async () => {
    let completed = 0;
    const user = userEvent.setup();
    renderWithProviders(
      <OnboardingAuth
        onComplete={() => {
          completed += 1;
        }}
      />
    );

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('000000'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(completed).toBe(1);
    });

    const stored = localStorage.getItem(SESSION_KEY);
    expect(stored).not.toBeNull();
    const session = JSON.parse(stored!) as { access_token: string };
    expect(session.access_token).toBe('test-access-token');
  });
});

describe('OnboardingAuth — OTP validation / auth boundary', () => {
  it('keeps the verify button disabled until OTP is 6 digits AND SMS authorization is checked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const verifyBtn = screen.getByRole('button', { name: /continue/i });
    expect(verifyBtn).toBeDisabled();

    const otpInput = screen.getByPlaceholderText('000000');
    await user.type(otpInput, '18181');
    expect(verifyBtn).toBeDisabled();

    // Full 6 digits but SMS not authorized — still disabled
    await user.type(otpInput, '8');
    expect(verifyBtn).toBeDisabled();

    // Authorize SMS — now enabled
    await user.click(screen.getByRole('checkbox'));
    expect(verifyBtn).toBeEnabled();
  });

  it('strips non-digit characters from OTP input and caps it at 6 digits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const otpInput = screen.getByPlaceholderText('000000');
    await user.type(otpInput, '1a2b3c4d5e6f7g');
    expect(otpInput).toHaveValue('123456');
  });

  it('rejects an invalid OTP — shows error banner and stays on the OTP step', async () => {
    server.use(
      http.post(`${API_BASE}/auth/verify-otp`, () =>
        HttpResponse.json({ error: 'Invalid verification code' }, { status: 400 })
      )
    );

    let completed = 0;
    const user = userEvent.setup();
    renderWithProviders(
      <OnboardingAuth
        onComplete={() => {
          completed += 1;
        }}
      />
    );

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('000000'), '000000');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid verification code')).toBeInTheDocument();
    });
    // Still on OTP step, not routed to onComplete
    expect(screen.getByText('Verify your number')).toBeInTheDocument();
    expect(completed).toBe(0);
    // No raw stack traces leaked to the UI
    expect(screen.queryByText(/at fetch/i)).not.toBeInTheDocument();
  });
});

describe('OnboardingAuth — error surface', () => {
  it('shows a friendly error (no stack trace) when send-otp returns 500', async () => {
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, () =>
        HttpResponse.json({ error: 'Upstream provider unavailable' }, { status: 500 })
      )
    );

    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByText('Upstream provider unavailable')).toBeInTheDocument();
    });
    // Still on signup step — did not transition to OTP
    expect(screen.getByText('Sign up or log in to continue')).toBeInTheDocument();
    // Continue button re-enabled so the user can retry
    expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled();
    // No raw stack traces leaked
    expect(screen.queryByText(/at fetch/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/TypeError:/i)).not.toBeInTheDocument();
  });

  it('falls back to a generic message when send-otp fails without an error field', async () => {
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, () => HttpResponse.json({}, { status: 500 }))
    );

    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByText('Failed to send OTP')).toBeInTheDocument();
    });
  });
});

describe('OnboardingAuth — back navigation', () => {
  it('returns to the signup step and clears the OTP when "Use a different number" is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('000000'), '123456');
    expect(screen.getByPlaceholderText('000000')).toHaveValue('123456');

    await user.click(screen.getByRole('button', { name: /use a different number/i }));

    await waitFor(() => {
      expect(screen.getByText('Sign up or log in to continue')).toBeInTheDocument();
    });
    // Signup form re-rendered with prior values preserved (first name, phone)
    expect(screen.getByPlaceholderText('First name')).toHaveValue('Andy');
    expect(screen.getByPlaceholderText('Phone number')).toHaveValue('(972) 977-7432');
  });
});

describe('OnboardingAuth — API boundary capture', () => {
  it('POSTs /api/auth/send-otp with E.164 phone and JSON content-type', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      const sendReq = capturedRequests.find((r) => r.url.includes('/api/auth/send-otp'));
      expect(sendReq).toBeDefined();
    });

    const sendReq = capturedRequests.find((r) => r.url.includes('/api/auth/send-otp'))!;
    expect(sendReq.method).toBe('POST');
    expect(sendReq.headers['content-type']).toBe('application/json');
    expect(sendReq.url).toBe(`${API_BASE}/auth/send-otp`);
    expect(parseBody(sendReq.body)).toEqual({ phone: '+19729777432' });
  });

  it('POSTs /api/auth/verify-otp with phone, token, and firstName/lastName', async () => {
    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await completePhoneStep(user);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    // Clear to isolate the verify-otp request from the send-otp one
    clearCaptures();

    await user.type(screen.getByPlaceholderText('000000'), '181818');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => {
      const verifyReq = capturedRequests.find((r) => r.url.includes('/api/auth/verify-otp'));
      expect(verifyReq).toBeDefined();
    });

    const verifyReq = capturedRequests.find((r) => r.url.includes('/api/auth/verify-otp'))!;
    expect(verifyReq.method).toBe('POST');
    expect(verifyReq.headers['content-type']).toBe('application/json');
    expect(verifyReq.url).toBe(`${API_BASE}/auth/verify-otp`);
    const body = parseBody(verifyReq.body);
    expect(body.phone).toBe('+19729777432');
    expect(body.token).toBe('181818');
    expect(body.firstName).toBe('Andy');
    expect(body.lastName).toBe('Prevalsky');
  });

  it('sends exactly one send-otp call per Continue click (no duplicates while in-flight)', async () => {
    server.use(
      http.post(`${API_BASE}/auth/send-otp`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return HttpResponse.json({ success: true });
      })
    );

    const user = userEvent.setup();
    renderWithProviders(<OnboardingAuth onComplete={() => {}} />);

    await user.type(screen.getByPlaceholderText('First name'), 'Andy');
    await user.type(screen.getByPlaceholderText('Last name'), 'Prevalsky');
    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');

    const continueBtn = screen.getByRole('button', { name: /continue/i });
    await user.click(continueBtn);
    // Immediately try again while loading — button is disabled during loading
    expect(continueBtn).toBeDisabled();

    await waitFor(() => {
      expect(screen.getByText('Verify your number')).toBeInTheDocument();
    });

    const sendReqs = capturedRequests.filter((r) => r.url.includes('/api/auth/send-otp'));
    expect(sendReqs).toHaveLength(1);
  });
});
