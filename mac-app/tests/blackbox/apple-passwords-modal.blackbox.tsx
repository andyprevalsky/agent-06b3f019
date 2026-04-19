import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { installIpcMock, clearIpcMock } from './ipc-mock';
import ApplePasswordsModal from '../../ui/components/ApplePasswordsModal';

/**
 * Black-box coverage for the ApplePasswordsModal renderer component.
 *
 * Source under test: `mac-app/ui/components/ApplePasswordsModal.tsx`. This is a
 * pure renderer-ui modal that guides users through exporting Apple Passwords
 * to CSV and uploading it. External boundaries:
 *   1. IPC: `window.api.openPasswordsApp()` (the "Open Passwords" button)
 *   2. Parent callbacks: `onSync(file)` and `onClose()` (no backend calls on its own)
 *
 * State-machine sketch:
 *   closed (isOpen=false) ---(isOpen=true)--> idle
 *   idle --(select .csv)--> fileSelected
 *   idle --(select non-.csv)--> error(idle)
 *   fileSelected --(click Import + onSync resolves)--> done (parent closes)
 *   fileSelected --(click Import + onSync rejects)--> error(fileSelected)
 *   any --(click Cancel or backdrop, !loading)--> closed (reset)
 *   loading --(any close attempt)--> loading (no-op, inputs disabled)
 */

function makeCsvFile(name = 'passwords.csv', content = 'url,username,password\n'): File {
  return new File([content], name, { type: 'text/csv' });
}

function getFileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('File input not found — modal is not open');
  }
  return input;
}

function getBackdrop(): HTMLElement {
  // The modal backdrop is rendered via Tailwind classes and has no role/label;
  // there is no better selector short of adding a test id to the component.
  const el = document.querySelector('.bg-black\\/50');
  if (!(el instanceof HTMLElement)) {
    throw new Error('Backdrop not found — modal is not open');
  }
  return el;
}

beforeEach(() => {
  clearCaptures();
  // openPasswordsApp is fire-and-forget from the "Open Passwords" button —
  // provide a default no-op so tests that don't explicitly assert on it
  // don't crash the strict ipc-mock fallback.
  installIpcMock({ openPasswordsApp: vi.fn(async () => undefined) });
});

afterEach(() => {
  clearIpcMock();
});

describe('ApplePasswordsModal — render gating', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = renderWithProviders(
      <ApplePasswordsModal isOpen={false} onClose={() => {}} onSync={async () => {}} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Import Apple Passwords')).not.toBeInTheDocument();
  });

  it('renders the full modal content when isOpen is true', () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    // Header
    expect(screen.getByText('Import Apple Passwords')).toBeInTheDocument();
    // All four numbered instructions
    expect(screen.getByRole('button', { name: /open passwords/i })).toBeInTheDocument();
    expect(screen.getByText(/Export All Passwords to File/)).toBeInTheDocument();
    expect(screen.getByText(/upload it below/)).toBeInTheDocument();
    expect(screen.getByText(/Delete the CSV file/)).toBeInTheDocument();
    // Upload prompt + footer buttons
    expect(screen.getByText(/Click to upload/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeInTheDocument();
    // Security notice
    expect(screen.getByText(/encrypted end-to-end/i)).toBeInTheDocument();
  });
});

describe('ApplePasswordsModal — empty / initial state', () => {
  it('disables Import Passwords until a CSV file is selected', () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    expect(screen.getByRole('button', { name: /import passwords/i })).toBeDisabled();
  });

  it('shows the empty upload prompt (Click to upload / CSV file only) when no file is picked', () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    expect(screen.getByText(/Click to upload/)).toBeInTheDocument();
    expect(screen.getByText('CSV file only')).toBeInTheDocument();
  });

  it('renders no error message initially', () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    expect(screen.queryByText(/please select a csv file/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed to import passwords/i)).not.toBeInTheDocument();
  });
});

describe('ApplePasswordsModal — user interactions', () => {
  it('shows the filename and enables Import after a valid CSV is chosen via the input', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    const csv = makeCsvFile('my-passwords.csv');
    await user.upload(getFileInput(), csv);

    expect(screen.getByText('my-passwords.csv')).toBeInTheDocument();
    expect(screen.getByText(/click or drag to replace/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeEnabled();
  });

  it('rejects non-CSV files with a validation error and keeps Import disabled', async () => {
    // userEvent.upload respects the `accept=".csv"` attribute and filters out non-CSV
    // files before they reach the component. To exercise the component's OWN
    // extension-based validation, bypass the accept filter with applyAccept: false.
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    const input = getFileInput();
    const txt = new File(['not csv'], 'passwords.txt', { type: 'text/plain' });
    await user.upload(input, txt);

    expect(screen.getByText('Please select a CSV file')).toBeInTheDocument();
    expect(screen.queryByText('passwords.txt')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeDisabled();
  });

  it('invokes window.api.openPasswordsApp() exactly once when "Open Passwords" is clicked', async () => {
    const openSpy = vi.fn(() => Promise.resolve({ success: true }));
    installIpcMock({ openPasswordsApp: openSpy });

    const user = userEvent.setup();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    await user.click(screen.getByRole('button', { name: /open passwords/i }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('opens and closes the screenshot lightbox', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    // Only one screenshot img on mount
    const initialImgs = screen.getAllByAltText(/Passwords app showing File menu/i);
    expect(initialImgs).toHaveLength(1);

    // Click the zoom button (the inline image is wrapped in a button)
    await user.click(initialImgs[0].closest('button')!);
    const expandedImgs = screen.getAllByAltText(/Passwords app showing File menu/i);
    expect(expandedImgs.length).toBeGreaterThanOrEqual(2);

    // Click lightbox to close — the outer expanded wrapper has cursor-zoom-out
    const lightbox = document.querySelector('.cursor-zoom-out') as HTMLElement | null;
    expect(lightbox).not.toBeNull();
    await user.click(lightbox!);

    await waitFor(() => {
      const after = screen.getAllByAltText(/Passwords app showing File menu/i);
      expect(after).toHaveLength(1);
    });
  });

  it('calls onClose when the Cancel button is clicked (not loading)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={async () => {}} />
    );

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the backdrop is clicked (not loading)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={async () => {}} />
    );

    await user.click(getBackdrop());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('resets file/error state after Cancel → reopen', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={async () => {}} />
    );

    const input = getFileInput();
    await user.upload(input, makeCsvFile('first.csv'));
    expect(screen.getByText('first.csv')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Parent re-opens the modal fresh
    rerender(<ApplePasswordsModal isOpen={true} onClose={onClose} onSync={async () => {}} />);

    expect(screen.queryByText('first.csv')).not.toBeInTheDocument();
    expect(screen.getByText(/Click to upload/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeDisabled();
  });
});

describe('ApplePasswordsModal — happy path (onSync)', () => {
  it('invokes onSync exactly once with the selected File when Import is clicked', async () => {
    const onSync = vi.fn(async (_file: File) => {});
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    const input = getFileInput();
    const csv = makeCsvFile('secure.csv', 'url,username,password\nhttps://x,foo,bar\n');
    await user.upload(input, csv);

    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(onSync).toHaveBeenCalledTimes(1);
    });
    const passed = onSync.mock.calls[0][0];
    expect(passed).toBeInstanceOf(File);
    expect(passed.name).toBe('secure.csv');
  });

  it('shows the loading spinner / "Importing..." label while onSync is in flight', async () => {
    let resolveSync!: () => void;
    const onSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        })
    );
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(screen.getByText(/importing/i)).toBeInTheDocument();
    });
    // Cancel / close X / Import are all disabled during load
    expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /importing/i })).toBeDisabled();

    await act(async () => {
      resolveSync();
    });
  });
});

describe('ApplePasswordsModal — error surface', () => {
  it('surfaces the onSync rejection message and re-enables the form', async () => {
    const onSync = vi.fn(() => Promise.reject(new Error('RSA key unavailable')));
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(screen.getByText('RSA key unavailable')).toBeInTheDocument();
    });
    // Back to not-loading: Import re-enabled (file is still selected)
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
    // No raw stack traces leaked
    expect(screen.queryByText(/at handleSync/i)).not.toBeInTheDocument();
  });

  it('falls back to a generic message when onSync rejects with a non-Error value', async () => {
    const onSync = vi.fn(() => Promise.reject('boom'));
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(screen.getByText('Failed to import passwords')).toBeInTheDocument();
    });
  });

  it('clears a previous error when a new valid CSV is selected', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={async () => {}} />
    );

    const input = getFileInput();
    // First: non-CSV triggers error
    await user.upload(input, new File(['x'], 'bad.txt', { type: 'text/plain' }));
    expect(screen.getByText('Please select a CSV file')).toBeInTheDocument();

    // Now pick a valid CSV — error should clear
    await user.upload(input, makeCsvFile('good.csv'));
    expect(screen.queryByText('Please select a CSV file')).not.toBeInTheDocument();
    expect(screen.getByText('good.csv')).toBeInTheDocument();
  });
});

describe('ApplePasswordsModal — cleanup / idempotency', () => {
  it('ignores Cancel / backdrop clicks while onSync is in flight (no double onClose)', async () => {
    let resolveSync!: () => void;
    const onSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        })
    );
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={onClose} onSync={onSync} />);

    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(screen.getByText(/importing/i)).toBeInTheDocument();
    });

    // Attempt to close via Cancel (disabled) and backdrop (guarded)
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(getBackdrop());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveSync();
    });
  });

  it('fires onSync once per click even if the user clicks Import rapidly (button disables during load)', async () => {
    let resolveSync!: () => void;
    const onSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        })
    );
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    const importBtn = screen.getByRole('button', { name: /import passwords/i });
    await user.click(importBtn);
    // Second click on the same (now-disabled) button is a no-op
    await user.click(importBtn);

    await waitFor(() => {
      expect(onSync).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      resolveSync();
    });
  });
});

describe('ApplePasswordsModal — backend boundary (MSW)', () => {
  it('makes zero backend HTTP calls across the full happy path', async () => {
    const onSync = vi.fn(async (_file: File) => {});
    const user = userEvent.setup();
    renderWithProviders(<ApplePasswordsModal isOpen={true} onClose={() => {}} onSync={onSync} />);

    // Open Passwords (IPC, not HTTP)
    await user.click(screen.getByRole('button', { name: /open passwords/i }));

    // Upload + Import (parent-owned, not HTTP)
    const input = getFileInput();
    await user.upload(input, makeCsvFile());
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(onSync).toHaveBeenCalledTimes(1);
    });

    // Boundary invariant: this modal itself never talks to the backend.
    // Upload is delegated to the parent via onSync(file).
    expect(capturedRequests).toHaveLength(0);
  });
});
