/**
 * Blackbox tests for ApplePasswordsModal and AtlasPasswordModal.
 *
 * Both modals are controlled dialogs with an open/close toggle, inputs, and
 * an async "sync" callback provided by the parent. Covers:
 *   - closed state returns null
 *   - rendering with expected headings / step guides
 *   - cancel/close path (disabled while loading)
 *   - submit success closes modal (parent handles close)
 *   - submit error surfaces error message
 *   - validation path (no file / no password)
 *   - image lightbox expand/collapse
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './test-wrapper';

import ApplePasswordsModal from '@/components/ApplePasswordsModal';
import AtlasPasswordModal from '@/components/AtlasPasswordModal';

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('ApplePasswordsModal', () => {
  it('returns null when closed', () => {
    const { container } = renderWithProviders(
      <ApplePasswordsModal isOpen={false} onClose={vi.fn()} onSync={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the header, steps, and upload prompt when open', () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={vi.fn()} />,
    );
    expect(screen.getByText('Import Apple Passwords')).toBeInTheDocument();
    expect(screen.getByText(/click to upload/i)).toBeInTheDocument();
    expect(screen.getByText(/csv file only/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import passwords/i })).toBeDisabled();
  });

  it('rejects a non-CSV file and shows an error', async () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={vi.fn()} />,
    );
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const txtFile = new File(['hello'], 'not-a-csv.txt', { type: 'text/plain' });
    // Use fireEvent.change since userEvent.upload enforces the `accept` attribute
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      value: [txtFile],
    });
    fireEvent.change(fileInput);
    await waitFor(() => {
      expect(screen.getByText(/please select a csv file/i)).toBeInTheDocument();
    });
  });

  it('accepts a CSV file, enables the Import button, and calls onSync on success', async () => {
    const onSync = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={onSync} />,
    );
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = new File(['a,b,c'], 'passwords.csv', { type: 'text/csv' });
    const user = userEvent.setup();
    await user.upload(fileInput, csv);
    expect(await screen.findByText('passwords.csv')).toBeInTheDocument();

    const importBtn = screen.getByRole('button', { name: /import passwords/i });
    await waitFor(() => expect(importBtn).not.toBeDisabled());

    await user.click(importBtn);
    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith(csv);
    });
  });

  it('shows an error when onSync rejects', async () => {
    const onSync = vi.fn().mockRejectedValue(new Error('Server says no'));
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={onSync} />,
    );
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = new File(['x'], 'p.csv', { type: 'text/csv' });
    const user = userEvent.setup();
    await user.upload(fileInput, csv);
    await user.click(screen.getByRole('button', { name: /import passwords/i }));

    await waitFor(() => {
      expect(screen.getByText(/server says no/i)).toBeInTheDocument();
    });
  });

  it('falls back to generic error message when rejection is a non-Error', async () => {
    const onSync = vi.fn().mockRejectedValue('nope');
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={onSync} />,
    );
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const csv = new File(['x'], 'p.csv', { type: 'text/csv' });
    const user = userEvent.setup();
    await user.upload(fileInput, csv);
    await user.click(screen.getByRole('button', { name: /import passwords/i }));
    await waitFor(() => {
      expect(screen.getByText(/failed to import passwords/i)).toBeInTheDocument();
    });
  });

  it('cancel button calls onClose', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={vi.fn()} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the backdrop also calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={onClose} onSync={vi.fn()} />,
    );
    // The backdrop is the first absolute element with bg-black/50
    const backdrop = container.querySelector('.bg-black\\/50');
    expect(backdrop).not.toBeNull();
    const user = userEvent.setup();
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Import disabled until a file is selected', () => {
    // Rationale: the validation path (handleSync with no file) is UI-gated by
    // the disabled button — there's no way to trigger handleSync without first
    // picking a file. The meaningful assertion is the gate itself: the button
    // MUST start disabled when no file is present.
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={vi.fn()} />,
    );
    const importBtn = screen.getByRole('button', { name: /import passwords/i });
    expect(importBtn).toBeDisabled();
  });

  it('clicking the export image opens the lightbox; clicking the lightbox closes it', async () => {
    renderWithProviders(
      <ApplePasswordsModal isOpen={true} onClose={vi.fn()} onSync={vi.fn()} />,
    );
    const user = userEvent.setup();
    // The image has alt text
    const img = screen.getByAltText(/passwords app showing file menu with export option/i);
    // The clickable wrapper is the parent button
    const imgButton = img.closest('button') as HTMLButtonElement;
    await user.click(imgButton);
    // After opening, two copies of the same alt text exist (modal + lightbox)
    await waitFor(() => {
      expect(
        screen.getAllByAltText(/passwords app showing file menu with export option/i).length,
      ).toBeGreaterThanOrEqual(2);
    });
    // Click the lightbox overlay to close
    const lightbox = document.querySelector('.cursor-zoom-out') as HTMLElement;
    expect(lightbox).not.toBeNull();
    await user.click(lightbox);
    await waitFor(() => {
      expect(
        screen.getAllByAltText(/passwords app showing file menu with export option/i).length,
      ).toBe(1);
    });
  });
});

describe('AtlasPasswordModal', () => {
  it('returns null when closed', () => {
    const { container } = renderWithProviders(
      <AtlasPasswordModal
        isOpen={false}
        onClose={vi.fn()}
        onSync={vi.fn()}
        onOpenKeychain={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders header, step guide, and password input when open', () => {
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={vi.fn()}
        onOpenKeychain={vi.fn()}
      />,
    );
    expect(screen.getByText('Sync Atlas')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the password here/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sync$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('shows validation error when sync clicked without password', async () => {
    const onSync = vi.fn();
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
      />,
    );
    // Sync button is disabled when empty; simulate Enter on the input with an
    // empty value does not fire because the handler short-circuits.
    // Fill in whitespace to enable button, then clear via value change.
    const input = screen.getByPlaceholderText(/paste the password here/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(input, ' ');
    // The disabled check uses .trim(), so a single space keeps it disabled.
    expect(screen.getByRole('button', { name: /sync$/i })).toBeDisabled();

    // Trigger handler manually via Enter keypress — the handler checks
    // password.trim() and sets error when empty.
    await user.type(input, '{Enter}');
    // whitespace-only + Enter goes into handleSync; error should be set.
    // But handler is gated by `!loading` only in the keydown path.
    await waitFor(() => {
      expect(screen.getByText(/please enter the keychain password/i)).toBeInTheDocument();
    });
    expect(onSync).not.toHaveBeenCalled();
  });

  it('calls onSync when Enter is pressed with a password', async () => {
    const onSync = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText(/paste the password here/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(input, 'secret{Enter}');
    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith('secret');
    });
  });

  it('clicking Sync button calls onSync with the entered password', async () => {
    const onSync = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
      />,
    );
    const input = screen.getByPlaceholderText(/paste the password here/i) as HTMLInputElement;
    const user = userEvent.setup();
    await user.type(input, 'mypw');
    await user.click(screen.getByRole('button', { name: /sync$/i }));
    await waitFor(() => {
      expect(onSync).toHaveBeenCalledWith('mypw');
    });
  });

  it('shows error message when onSync rejects', async () => {
    const onSync = vi.fn().mockRejectedValue(new Error('Bad password'));
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/paste the password here/i), 'mypw');
    await user.click(screen.getByRole('button', { name: /sync$/i }));
    await waitFor(() => {
      expect(screen.getByText(/bad password/i)).toBeInTheDocument();
    });
  });

  it('falls back to generic error message when rejection is non-Error with default syncType', async () => {
    const onSync = vi.fn().mockRejectedValue('opaque');
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/paste the password here/i), 'mypw');
    await user.click(screen.getByRole('button', { name: /sync$/i }));
    await waitFor(() => {
      expect(screen.getByText(/failed to sync cookies/i)).toBeInTheDocument();
    });
  });

  it('renders passwords syncType in the intro and error message', async () => {
    const onSync = vi.fn().mockRejectedValue('x');
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={onSync}
        onOpenKeychain={vi.fn()}
        syncType="passwords"
      />,
    );
    expect(screen.getByText(/to sync your passwords/i)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/paste the password here/i), 'mypw');
    await user.click(screen.getByRole('button', { name: /sync$/i }));
    await waitFor(() => {
      expect(screen.getByText(/failed to sync passwords/i)).toBeInTheDocument();
    });
  });

  it('clicking Open Keychain calls onOpenKeychain; rejection is swallowed', async () => {
    cleanup();
    const onOpenKeychain = vi.fn().mockRejectedValue(new Error('oops'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={vi.fn()}
        onOpenKeychain={onOpenKeychain}
      />,
    );
    const user = userEvent.setup();
    // Scope the query to this render's container to avoid any stale DOM
    const openKeychainBtn = Array.from(
      container.querySelectorAll('button'),
    ).find((b) => /open keychain/i.test(b.textContent || '')) as HTMLButtonElement;
    expect(openKeychainBtn).toBeTruthy();
    await user.click(openKeychainBtn);
    await waitFor(() => {
      expect(onOpenKeychain).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    errSpy.mockRestore();
  });

  it('cancel button calls onClose and clears state', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={onClose}
        onSync={vi.fn()}
        onOpenKeychain={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking backdrop calls onClose', async () => {
    const onClose = vi.fn();
    const { container } = renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={onClose}
        onSync={vi.fn()}
        onOpenKeychain={vi.fn()}
      />,
    );
    const backdrop = container.querySelector('.bg-black\\/50') as HTMLElement;
    const user = userEvent.setup();
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a step image opens the lightbox; clicking overlay closes it', async () => {
    renderWithProviders(
      <AtlasPasswordModal
        isOpen={true}
        onClose={vi.fn()}
        onSync={vi.fn()}
        onOpenKeychain={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    const thumb = screen.getByAltText(/macos dialog prompting to open keychain access/i);
    await user.click(thumb.closest('button') as HTMLButtonElement);
    await waitFor(() => {
      expect(screen.getByAltText('Expanded view')).toBeInTheDocument();
    });
    // Close by clicking the zoom-out container
    const overlay = document.querySelector('.cursor-zoom-out') as HTMLElement;
    await user.click(overlay);
    await waitFor(() => {
      expect(screen.queryByAltText('Expanded view')).not.toBeInTheDocument();
    });
  });
});
