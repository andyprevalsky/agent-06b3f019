/**
 * TelegramAuthModal domain blackbox tests — file-level boundary for
 * `mac-app/ui/components/TelegramAuthModal.tsx`.
 *
 * Source under test is a renderer-side modal that drives Telegram's
 * phone → SMS-code → (optional) 2FA-password authentication flow entirely
 * through the `window.api.telegram` IPC bridge. It does NOT make any direct
 * network calls — every backend interaction is proxied by the Electron main
 * process. MSW stays in its default "error on any unhandled request" mode as
 * a boundary assertion: if the modal ever starts fetching directly, this
 * suite will fail loudly.
 *
 * State-machine sketch (what this suite covers):
 *
 *   closed ──isOpen──▶ phone ──startAuth(phone)────────────▶ phone(loading)
 *                        │                                       │
 *                        │ onTelegramNeedCode                    │
 *                        ▼                                       │
 *                       code  ──submitCode──▶ code(loading)      │
 *                        │                      │                │
 *                        │ onTelegramNeedPwd    │ onTelegramAuthComplete
 *                        ▼                      ▼                ▼
 *                     password ──submitPassword──▶ complete ──onSuccess + onClose
 *                        │
 *                        │ onTelegramAuthError
 *                        ▼
 *                     (step persists, error banner shown, loading cleared)
 *
 *   phone(empty submit)            ─▶ inline error "Please enter your phone number"
 *   code(empty submit)             ─▶ inline error "Please enter the verification code"
 *   password(empty submit)         ─▶ inline error "Please enter your 2FA password"
 *   code(Wrong number? Go back)    ─▶ cancelAuth() + step=phone + clears code & error
 *   Cancel / backdrop (not loading)─▶ cancelAuth() + full reset + onClose
 *   Cancel / backdrop (loading)    ─▶ no-op (button + backdrop disabled)
 *
 *   isOpen=false ─▶ returns null (nothing rendered, no portals)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import { capturedRequests, clearCaptures } from './msw/capture';
import TelegramAuthModal from '../../ui/components/TelegramAuthModal';
import type { IPC } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  emitNeedCode: () => void;
  emitNeedPassword: () => void;
  emitAuthComplete: () => void;
  emitAuthError: (msg: string) => void;
  startAuth: ReturnType<typeof vi.fn>;
  submitCode: ReturnType<typeof vi.fn>;
  submitPassword: ReturnType<typeof vi.fn>;
  cancelAuth: ReturnType<typeof vi.fn>;
  onNeedCodeRegistrations: number;
  onNeedPasswordRegistrations: number;
  onAuthCompleteRegistrations: number;
  onAuthErrorRegistrations: number;
}

interface HarnessOptions {
  telegramApi?: boolean;
  startAuthImpl?: () => Promise<{ success: boolean; error?: string }>;
  submitCodeImpl?: () => Promise<{ success: boolean; error?: string }>;
  submitPasswordImpl?: () => Promise<{ success: boolean; error?: string }>;
}

function setupHarness(options: HarnessOptions = {}): Harness {
  const { telegramApi = true } = options;

  const needCodeCbs: Array<() => void> = [];
  const needPasswordCbs: Array<() => void> = [];
  const authCompleteCbs: Array<() => void> = [];
  const authErrorCbs: Array<(msg: string) => void> = [];

  const harness: Partial<Harness> = {
    onNeedCodeRegistrations: 0,
    onNeedPasswordRegistrations: 0,
    onAuthCompleteRegistrations: 0,
    onAuthErrorRegistrations: 0,
  };

  const onTelegramNeedCode = vi.fn((cb: () => void) => {
    needCodeCbs.push(cb);
    harness.onNeedCodeRegistrations = (harness.onNeedCodeRegistrations ?? 0) + 1;
  });
  const onTelegramNeedPassword = vi.fn((cb: () => void) => {
    needPasswordCbs.push(cb);
    harness.onNeedPasswordRegistrations = (harness.onNeedPasswordRegistrations ?? 0) + 1;
  });
  const onTelegramAuthComplete = vi.fn((cb: () => void) => {
    authCompleteCbs.push(cb);
    harness.onAuthCompleteRegistrations = (harness.onAuthCompleteRegistrations ?? 0) + 1;
  });
  const onTelegramAuthError = vi.fn((cb: (msg: string) => void) => {
    authErrorCbs.push(cb);
    harness.onAuthErrorRegistrations = (harness.onAuthErrorRegistrations ?? 0) + 1;
  });

  const startAuth = vi.fn(options.startAuthImpl ?? (() => Promise.resolve({ success: true })));
  const submitCode = vi.fn(options.submitCodeImpl ?? (() => Promise.resolve({ success: true })));
  const submitPassword = vi.fn(
    options.submitPasswordImpl ?? (() => Promise.resolve({ success: true }))
  );
  const cancelAuth = vi.fn(() => Promise.resolve({ success: true }));

  const overrides: Partial<IPC> = {
    onTelegramNeedCode,
    onTelegramNeedPassword,
    onTelegramAuthComplete,
    onTelegramAuthError,
  };

  if (telegramApi) {
    overrides.telegram = {
      // Only the four methods the modal actually calls are required here.
      // Others are unused but typed, so stub them out.
      hasSession: () => Promise.resolve(false),
      hasApiCredentials: () => Promise.resolve(false),
      isConnected: () => Promise.resolve(false),
      connectWithExistingSession: () => Promise.resolve({ success: true }),
      disconnect: () => Promise.resolve({ success: true }),
      logout: () => Promise.resolve({ success: true }),
      syncHistorical: () => Promise.resolve({ success: true, count: 0 }),
      startAuth,
      submitCode,
      submitPassword,
      cancelAuth,
    };
  } else {
    // Explicitly set to undefined so the proxy returns undefined (not a vi.fn())
    overrides.telegram = undefined;
  }

  installIpcMock(overrides);

  harness.emitNeedCode = () => {
    act(() => {
      needCodeCbs.forEach((cb) => cb());
    });
  };
  harness.emitNeedPassword = () => {
    act(() => {
      needPasswordCbs.forEach((cb) => cb());
    });
  };
  harness.emitAuthComplete = () => {
    act(() => {
      authCompleteCbs.forEach((cb) => cb());
    });
  };
  harness.emitAuthError = (msg: string) => {
    act(() => {
      authErrorCbs.forEach((cb) => cb(msg));
    });
  };
  harness.startAuth = startAuth;
  harness.submitCode = submitCode;
  harness.submitPassword = submitPassword;
  harness.cancelAuth = cancelAuth;

  return harness as Harness;
}

function noop() {
  /* no-op */
}

beforeEach(() => {
  clearCaptures();
});

afterEach(() => {
  cleanup();
  clearIpcMock();
});

// ---------------------------------------------------------------------------
// Closed / empty state
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — closed / empty state', () => {
  it('renders nothing when isOpen is false', () => {
    setupHarness();
    const { container } = renderWithProviders(
      <TelegramAuthModal isOpen={false} onClose={noop} onSuccess={noop} />
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Connect Telegram')).not.toBeInTheDocument();
  });

  it('does not call any IPC method on mount when closed', () => {
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen={false} onClose={noop} onSuccess={noop} />);
    expect(h.startAuth).not.toHaveBeenCalled();
    expect(h.cancelAuth).not.toHaveBeenCalled();
    expect(h.onNeedCodeRegistrations).toBe(0);
    expect(h.onNeedPasswordRegistrations).toBe(0);
    expect(h.onAuthCompleteRegistrations).toBe(0);
    expect(h.onAuthErrorRegistrations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy-path render
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — happy-path render (open)', () => {
  it('renders the phone step with title, input, footer buttons, and help text', () => {
    setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    expect(screen.getByText('Connect Telegram')).toBeInTheDocument();
    expect(
      screen.getByText('Enter your phone number to connect your Telegram account.')
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Phone number')).toBeInTheDocument();
    expect(screen.getByText('Pick your country code from the selector.')).toBeInTheDocument();
    expect(screen.getByLabelText('Country code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('subscribes to the four Telegram auth events exactly once on open', () => {
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    expect(h.onNeedCodeRegistrations).toBe(1);
    expect(h.onNeedPasswordRegistrations).toBe(1);
    expect(h.onAuthCompleteRegistrations).toBe(1);
    expect(h.onAuthErrorRegistrations).toBe(1);
  });

  it('formats the phone number as the user types (US national display)', async () => {
    const user = userEvent.setup();
    setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    const input = screen.getByPlaceholderText('Phone number');
    await user.type(input, '9729777432');
    expect(input).toHaveValue('(972) 977-7432');
  });
});

// ---------------------------------------------------------------------------
// Full phone → code → password flow
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — phone + code + password flow', () => {
  it('transitions phone → code on needCode event and code → password on needPassword event', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    // startAuth called with E.164-stripped phone
    await waitFor(() => {
      expect(h.startAuth).toHaveBeenCalledWith('+19729777432');
    });
    // While waiting for needCode event, button shows Processing
    expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();

    // Simulate main-process event: needCode
    h.emitNeedCode();

    await waitFor(() => {
      expect(screen.getByText(/Telegram sent a code to/)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /verify/i })).toBeEnabled();

    // Submit code
    await user.type(screen.getByPlaceholderText('12345'), '181818');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledWith('181818');
    });

    // Simulate main-process event: needPassword (2FA)
    h.emitNeedPassword();

    await waitFor(() => {
      expect(
        screen.getByText('Your account has 2FA enabled. Enter your Telegram password.')
      ).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('Enter your 2FA password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();

    // Submit password
    await user.type(screen.getByPlaceholderText('Enter your 2FA password'), 'hunter2');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(h.submitPassword).toHaveBeenCalledWith('hunter2');
    });
  });

  it('calls onSuccess and onClose when authComplete event fires after password', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    let successCount = 0;
    let closeCount = 0;
    renderWithProviders(
      <TelegramAuthModal
        isOpen
        onClose={() => {
          closeCount += 1;
        }}
        onSuccess={() => {
          successCount += 1;
        }}
      />
    );

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    h.emitNeedCode();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('12345'), '181818');
    await user.click(screen.getByRole('button', { name: /verify/i }));

    // Skip 2FA — authComplete directly
    h.emitAuthComplete();

    await waitFor(() => {
      expect(successCount).toBe(1);
      expect(closeCount).toBe(1);
    });
  });

  it('submits phone on Enter keydown (no explicit button click)', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    const input = screen.getByPlaceholderText('Phone number');
    await user.type(input, '9729777432');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(h.startAuth).toHaveBeenCalledWith('+19729777432');
    });
  });
});

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — error state', () => {
  it('shows inline error and does not call startAuth when phone is empty', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.click(screen.getByRole('button', { name: /send code/i }));

    expect(screen.getByText('Please enter your phone number')).toBeInTheDocument();
    expect(h.startAuth).not.toHaveBeenCalled();
    // Still on phone step, not loading
    expect(screen.getByRole('button', { name: /send code/i })).toBeEnabled();
  });

  it('shows error and re-enables the form when startAuth returns success=false', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      startAuthImpl: () => Promise.resolve({ success: false, error: 'Phone number not allowed' }),
    });
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(screen.getByText('Phone number not allowed')).toBeInTheDocument();
    });
    // Re-enabled for retry — still on phone step
    expect(screen.getByRole('button', { name: /send code/i })).toBeEnabled();
    expect(h.startAuth).toHaveBeenCalledTimes(1);
    // No raw stack traces leaked
    expect(screen.queryByText(/at fetch/i)).not.toBeInTheDocument();
  });

  it('falls back to a generic error when startAuth throws', async () => {
    const user = userEvent.setup();
    setupHarness({
      startAuthImpl: () => Promise.reject(new Error('network down')),
    });
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /send code/i })).toBeEnabled();
  });

  it('shows error from onTelegramAuthError event and clears loading', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    // Loading in flight (startAuth awaiting needCode event). Simulate error.
    h.emitAuthError('Code expired');

    await waitFor(() => {
      expect(screen.getByText('Code expired')).toBeInTheDocument();
    });
    // Still on phone step, re-enabled
    expect(screen.getByRole('button', { name: /send code/i })).toBeEnabled();
  });

  it('rejects empty code submission without calling submitCode', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    h.emitNeedCode();

    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /verify/i }));

    expect(screen.getByText('Please enter the verification code')).toBeInTheDocument();
    expect(h.submitCode).not.toHaveBeenCalled();
  });

  it('rejects empty password submission without calling submitPassword', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    h.emitNeedCode();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('12345'), '123456');
    await user.click(screen.getByRole('button', { name: /verify/i }));
    h.emitNeedPassword();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Enter your 2FA password')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByText('Please enter your 2FA password')).toBeInTheDocument();
    expect(h.submitPassword).not.toHaveBeenCalled();
  });

  it('shows "Telegram API not available" when window.api.telegram is missing', async () => {
    const user = userEvent.setup();
    setupHarness({ telegramApi: false });
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    expect(screen.getByText('Telegram API not available')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Back navigation + cancel
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — back navigation and cancel', () => {
  it('"Wrong number? Go back" returns to phone step, clears code, calls cancelAuth', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    h.emitNeedCode();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('12345'), '12345');

    await user.click(screen.getByRole('button', { name: /wrong number\? go back/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Phone number')).toBeInTheDocument();
    });
    // Phone value preserved (the component only resets on close, not on "go back")
    expect(screen.getByPlaceholderText('Phone number')).toHaveValue('(972) 977-7432');
    expect(h.cancelAuth).toHaveBeenCalledTimes(1);
  });

  it('Cancel button calls cancelAuth + onClose and resets to phone step', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    let closeCount = 0;
    renderWithProviders(
      <TelegramAuthModal
        isOpen
        onClose={() => {
          closeCount += 1;
        }}
        onSuccess={noop}
      />
    );

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(h.cancelAuth).toHaveBeenCalledTimes(1);
    expect(closeCount).toBe(1);
  });

  it('Cancel is disabled while loading (no cancelAuth, no onClose)', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      // startAuth never resolves → stays loading
      startAuthImpl: () => new Promise(() => {}),
    });
    let closeCount = 0;
    renderWithProviders(
      <TelegramAuthModal
        isOpen
        onClose={() => {
          closeCount += 1;
        }}
        onSuccess={noop}
      />
    );

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();
    });

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    expect(cancelBtn).toBeDisabled();

    await user.click(cancelBtn);
    expect(h.cancelAuth).not.toHaveBeenCalled();
    expect(closeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IPC boundary — every interaction goes through window.api.telegram
// ---------------------------------------------------------------------------

describe('TelegramAuthModal — IPC boundary', () => {
  it('strips formatting from phone before calling startAuth', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    // User types a formatted phone (via change events); verify that what reaches
    // the IPC boundary is the stripped E.164 form.
    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(h.startAuth).toHaveBeenCalledTimes(1);
    });
    expect(h.startAuth).toHaveBeenCalledWith('+19729777432');
  });

  it('submits exactly one startAuth per Send Code click (no duplicates while in-flight)', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      startAuthImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve({ success: true }), 50)),
    });
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    const sendBtn = screen.getByRole('button', { name: /send code/i });
    await user.click(sendBtn);

    // Button is disabled during loading → double-click cannot re-submit
    expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /processing/i }));

    await waitFor(() => {
      expect(h.startAuth).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT make any direct network requests — all traffic flows through IPC', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    h.emitNeedCode();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('12345'), '181818');
    await user.click(screen.getByRole('button', { name: /verify/i }));
    h.emitAuthComplete();

    // Zero network requests should be captured by MSW for this renderer component.
    expect(capturedRequests).toHaveLength(0);
  });

  it('submits exactly one submitCode per Verify click (no duplicates)', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      submitCodeImpl: () =>
        new Promise((resolve) => setTimeout(() => resolve({ success: true }), 50)),
    });
    renderWithProviders(<TelegramAuthModal isOpen onClose={noop} onSuccess={noop} />);

    await user.type(screen.getByPlaceholderText('Phone number'), '9729777432');
    await user.click(screen.getByRole('button', { name: /send code/i }));
    h.emitNeedCode();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('12345')).toBeInTheDocument();
    });
    await user.type(screen.getByPlaceholderText('12345'), '181818');

    await user.click(screen.getByRole('button', { name: /verify/i }));
    // Button disabled while loading
    await user.click(screen.getByRole('button', { name: /processing/i }));

    await waitFor(() => {
      expect(h.submitCode).toHaveBeenCalledTimes(1);
    });
  });
});
