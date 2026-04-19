/**
 * AtlasPasswordModal domain blackbox tests — file-level boundary for
 * `mac-app/ui/components/AtlasPasswordModal.tsx`.
 *
 * The modal prompts users to paste the Atlas (ChatGPT Desktop) Safe Storage
 * keychain password so the app can decrypt protected cookies/passwords. It
 * has three boundaries:
 *   1. Props: `onSync(password)` and `onClose()` callbacks from the parent.
 *   2. IPC: `window.api.openKeychainAccess('ChatGPT Safe Storage')` via the
 *      preload bridge (mocked with `installIpcMock`).
 *   3. Network: none — the component must not make any HTTP calls (enforced
 *      by MSW's `onUnhandledRequest: 'error'`).
 *
 * State-machine sketch covered by this suite:
 *                       (isOpen=false)
 *                             │
 *                             ▼
 *   closed ──isOpen=true──▶ idle ──type──▶ ready ──click Sync / Enter──▶ loading
 *                             ▲                                    │     │
 *                             │                                    │     ▼
 *                             │                                    │   success ──(parent closes)──▶ closed
 *                             │                                    ▼
 *                             └──────────── onSync rejects ──── error
 *
 *   idle/ready ──click Cancel / backdrop──▶ closed (password + error reset)
 *   loading    ──click Cancel / backdrop──▶ (no-op; disabled)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import { capturedRequests, clearCaptures } from './msw/capture';
import AtlasPasswordModal from '../../ui/components/AtlasPasswordModal';
import type { IPC } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  onSync: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  openKeychainAccess: ReturnType<typeof vi.fn>;
}

function setupHarness(
  options: {
    onSyncImpl?: (password: string) => Promise<void>;
    openKeychainImpl?: (searchQuery?: string) => Promise<{ success: boolean }>;
  } = {}
): Harness {
  const onSync = vi.fn(options.onSyncImpl ?? (async () => {}));
  const onClose = vi.fn();
  const openKeychainAccess = vi.fn(options.openKeychainImpl ?? (async () => ({ success: true })));

  installIpcMock({
    openKeychainAccess,
  } as Partial<IPC>);

  return { onSync, onClose, openKeychainAccess };
}

afterEach(() => {
  cleanup();
  clearIpcMock();
  clearCaptures();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Module boundary
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — module boundary', () => {
  it('default-exports a React component', () => {
    expect(typeof AtlasPasswordModal).toBe('function');
  });

  it('renders nothing when isOpen=false (closed state)', () => {
    const h = setupHarness();
    const { container } = renderWithProviders(
      <AtlasPasswordModal isOpen={false} onClose={h.onClose} onSync={h.onSync} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Sync Atlas')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Happy path render
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — render (happy path)', () => {
  it('renders header, steps, input and footer when isOpen=true', () => {
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    // Heading
    expect(screen.getByRole('heading', { name: 'Sync Atlas' })).toBeInTheDocument();

    // Steps text (syncType defaults to 'cookies')
    expect(
      screen.getByText(/uses a protected keychain\. To sync your cookies/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Double-click "ChatGPT Safe Storage"/i)).toBeInTheDocument();

    // Password input + visible label text
    expect(screen.getByText('Keychain Password')).toBeInTheDocument();
    expect(screen.getByLabelText(/keychain password/i)).toBeInTheDocument();

    // Footer buttons
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeInTheDocument();

    // "Open Keychain" helper button
    expect(screen.getByRole('button', { name: 'Open Keychain' })).toBeInTheDocument();
  });

  it('Sync button is disabled until a non-empty password is typed', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    const syncBtn = screen.getByRole('button', { name: 'Sync' });
    expect(syncBtn).toBeDisabled();

    await user.type(screen.getByLabelText(/keychain password/i), 'secret-1234');
    expect(syncBtn).toBeEnabled();
  });

  it('renders the three keychain screenshots with alt text (accessibility)', () => {
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    expect(
      screen.getByAltText('macOS dialog prompting to open Keychain Access')
    ).toBeInTheDocument();
    expect(screen.getByAltText('Keychain Access showing ChatGPT Safe Storage')).toBeInTheDocument();
    expect(
      screen.getByAltText('ChatGPT Safe Storage dialog with Show password checkbox')
    ).toBeInTheDocument();
  });

  it.each([
    ['cookies' as const, /sync your cookies/i, /keep your cookies in sync/i],
    ['passwords' as const, /sync your passwords/i, /keep your passwords in sync/i],
    ['browser data' as const, /sync your browser data/i, /keep your browser data in sync/i],
  ])('syncType="%s" adapts the displayed copy', (syncType, instruction, securityNotice) => {
    const h = setupHarness();
    renderWithProviders(
      <AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} syncType={syncType} />
    );

    expect(screen.getByText(instruction)).toBeInTheDocument();
    expect(screen.getByText(securityNotice)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Password entry + submit (happy path)
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — submit', () => {
  it('clicking Sync invokes onSync with the typed password exactly once', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.type(screen.getByLabelText(/keychain password/i), 'hunter2');
    await user.click(screen.getByRole('button', { name: 'Sync' }));

    await waitFor(() => {
      expect(h.onSync).toHaveBeenCalledTimes(1);
    });
    expect(h.onSync).toHaveBeenCalledWith('hunter2');
  });

  it('pressing Enter in the password input submits (keyboard parity with click)', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    const input = screen.getByLabelText(/keychain password/i);
    await user.type(input, 'correct-horse{Enter}');

    await waitFor(() => {
      expect(h.onSync).toHaveBeenCalledWith('correct-horse');
    });
  });

  it('does not invoke onSync when Sync is clicked with an empty password (button disabled)', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    const syncBtn = screen.getByRole('button', { name: 'Sync' });
    expect(syncBtn).toBeDisabled();
    await user.click(syncBtn); // userEvent respects disabled and does not fire

    expect(h.onSync).not.toHaveBeenCalled();
  });

  it('rapid double-submit (two Enter keypresses) invokes onSync exactly once', async () => {
    // Re-entry guard regression: pressing Enter twice fast — before the
    // component re-renders with `disabled={loading}` — must not fire a second
    // onSync. A pending promise keeps the loading state active across both
    // keypresses so the guard is what prevents the second invocation.
    const user = userEvent.setup();
    let resolveSync!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const h = setupHarness({ onSyncImpl: () => pending });

    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    const input = screen.getByLabelText(/keychain password/i);
    await user.type(input, 'hunter2{Enter}{Enter}');

    expect(h.onSync).toHaveBeenCalledTimes(1);
    expect(h.onSync).toHaveBeenCalledWith('hunter2');

    await act(async () => {
      resolveSync();
    });
  });
});

// ---------------------------------------------------------------------------
// Loading state (async submit)
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — loading state', () => {
  it('shows "Syncing..." while onSync is in-flight and disables Cancel', async () => {
    const user = userEvent.setup();
    let resolveSync!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const h = setupHarness({ onSyncImpl: () => pending });

    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.type(screen.getByLabelText(/keychain password/i), 'abc');
    await user.click(screen.getByRole('button', { name: 'Sync' }));

    // Loading UI visible
    expect(await screen.findByText('Syncing...')).toBeInTheDocument();

    // Cancel disabled during loading
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByLabelText(/keychain password/i)).toBeDisabled();

    // onSync was invoked synchronously when the user clicked Sync — it's
    // already been called once. Settle the pending promise inside act() so
    // React flushes the resulting microtasks before afterEach tears down.
    expect(h.onSync).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSync();
    });
  });

  it('clicking the backdrop while loading does NOT invoke onClose (idempotency)', async () => {
    const user = userEvent.setup();
    let resolveSync!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveSync = resolve;
    });
    const h = setupHarness({ onSyncImpl: () => pending });

    const { container } = renderWithProviders(
      <AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />
    );

    await user.type(screen.getByLabelText(/keychain password/i), 'abc');
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Syncing...')).toBeInTheDocument();

    // Backdrop is the absolutely positioned div with bg-black/50.
    const backdrop = container.querySelector('.bg-black\\/50');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);

    expect(h.onClose).not.toHaveBeenCalled();
    expect(h.onSync).toHaveBeenCalledTimes(1);

    // Settle the pending promise so afterEach can tear down cleanly.
    await act(async () => {
      resolveSync();
    });
  });
});

// ---------------------------------------------------------------------------
// Error state (wrong password / onSync rejection)
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — error state', () => {
  it('renders the thrown Error.message when onSync rejects', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      onSyncImpl: async () => {
        throw new Error('Invalid keychain password');
      },
    });

    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.type(screen.getByLabelText(/keychain password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sync' }));

    expect(await screen.findByText('Invalid keychain password')).toBeInTheDocument();

    // Loading cleared — Sync button is back and not "Syncing..."
    expect(screen.queryByText('Syncing...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync' })).toBeEnabled();
  });

  it('falls back to "Failed to sync <syncType>" when onSync rejects with a non-Error', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      onSyncImpl: async () => {
        throw 'some non-Error value';
      },
    });

    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={h.onClose}
        onSync={h.onSync}
        syncType="passwords"
      />
    );

    await user.type(screen.getByLabelText(/keychain password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sync' }));

    expect(await screen.findByText('Failed to sync passwords')).toBeInTheDocument();
  });

  it('re-submitting after a failure clears the previous error message', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const h = setupHarness({
      onSyncImpl: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Invalid keychain password');
      },
    });

    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.type(screen.getByLabelText(/keychain password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('Invalid keychain password')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sync' }));

    await waitFor(() => {
      expect(screen.queryByText('Invalid keychain password')).not.toBeInTheDocument();
    });
    expect(h.onSync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Close / cancel behavior
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — close', () => {
  it('clicking Cancel invokes onClose', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the X (close) button invokes onClose', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop invokes onClose', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    const { container } = renderWithProviders(
      <AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />
    );

    const backdrop = container.querySelector('.bg-black\\/50');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);

    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('resets password + error when reopened after close (no leaked state)', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      onSyncImpl: async () => {
        throw new Error('bad');
      },
    });

    const { rerender } = renderWithProviders(
      <AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />
    );

    // Type a password and trigger an error so internal state is non-empty.
    await user.type(screen.getByLabelText(/keychain password/i), 'leak-check');
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    expect(await screen.findByText('bad')).toBeInTheDocument();

    // Cancel triggers the component's internal reset of password + error.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Close then reopen via the isOpen prop.
    rerender(<AtlasPasswordModal isOpen={false} onClose={h.onClose} onSync={h.onSync} />);
    rerender(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    expect(screen.getByRole('button', { name: 'Sync' })).toBeDisabled();
    expect((screen.getByLabelText(/keychain password/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('bad')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// IPC boundary — openKeychainAccess
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — IPC boundary', () => {
  it('clicking "Open Keychain" invokes window.api.openKeychainAccess with "ChatGPT Safe Storage"', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.click(screen.getByRole('button', { name: 'Open Keychain' }));

    await waitFor(() => {
      expect(h.openKeychainAccess).toHaveBeenCalledTimes(1);
    });
    expect(h.openKeychainAccess).toHaveBeenCalledWith('ChatGPT Safe Storage');
  });

  it('swallows openKeychainAccess errors — modal stays rendered, no crash', async () => {
    const user = userEvent.setup();
    const h = setupHarness({
      openKeychainImpl: async () => {
        throw new Error('keychain access blocked');
      },
    });
    // Silence the component's expected console.error for the failed IPC call.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.click(screen.getByRole('button', { name: 'Open Keychain' }));

    // Modal still rendered and interactive after IPC failure.
    // The console.error spy assertion lives inside waitFor so it awaits the
    // microtask scheduled by the rejected promise — without it the assertion
    // races the async catch block.
    await waitFor(() => {
      expect(h.openKeychainAccess).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();
    });
    expect(screen.getByRole('heading', { name: 'Sync Atlas' })).toBeInTheDocument();
    expect(screen.getByLabelText(/keychain password/i)).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// Image lightbox
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — image lightbox', () => {
  it('clicking a step screenshot opens the expanded lightbox, clicking it again closes it', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    // Initially, no expanded view.
    expect(screen.queryByAltText('Expanded view')).not.toBeInTheDocument();

    // Click step-0 thumbnail — find the button wrapping the alt-text image.
    const thumb = screen.getByAltText('macOS dialog prompting to open Keychain Access');
    const thumbButton = thumb.closest('button');
    expect(thumbButton).not.toBeNull();
    await user.click(thumbButton as HTMLButtonElement);

    // Expanded view appears.
    const expanded = await screen.findByAltText('Expanded view');
    expect(expanded).toBeInTheDocument();

    // Click the lightbox backdrop (the parent div with bg-black/80).
    const lightbox = expanded.parentElement;
    expect(lightbox).not.toBeNull();
    await user.click(lightbox as Element);

    await waitFor(() => {
      expect(screen.queryByAltText('Expanded view')).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Network boundary — the modal must NOT make HTTP calls
// ---------------------------------------------------------------------------

describe('AtlasPasswordModal — network boundary (MSW)', () => {
  it('makes zero HTTP requests across render + user interactions', async () => {
    const user = userEvent.setup();
    const h = setupHarness();
    renderWithProviders(<AtlasPasswordModal isOpen={true} onClose={h.onClose} onSync={h.onSync} />);

    await user.type(screen.getByLabelText(/keychain password/i), 'network-check');
    await user.click(screen.getByRole('button', { name: 'Sync' }));
    await waitFor(() => {
      expect(h.onSync).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: 'Open Keychain' }));

    // MSW capture buffer records every fetch that reaches the network layer.
    // The modal is pure UI + IPC + callbacks, so nothing should escape to fetch.
    // `onUnhandledRequest: 'error'` in setup.ts is the secondary guard.
    expect(capturedRequests).toHaveLength(0);
  });
});
