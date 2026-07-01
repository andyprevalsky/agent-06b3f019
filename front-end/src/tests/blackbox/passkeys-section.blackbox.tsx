import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import PasswordsSection from '@/features/integrations/components/PasswordsSection';
import PasskeysModal from '@/components/PasskeysModal';

const baseProps = {
  expanded: true,
  onToggle: vi.fn(),
  isBrowserCookiesAvailable: true,
  isPasskeysAvailable: true,
  chromePasswordsSynced: false,
  applePasswordsSynced: false,
  passkeysSynced: false,
  atlasPasswordsSynced: false,
  passwordSyncLoading: null,
  onChromeSync: vi.fn(),
  onPasskeysOpen: vi.fn(),
  onAtlasPasswordsOpen: vi.fn(),
  passwordRequestExpanded: false,
  onPasswordRequestExpand: vi.fn(),
  passwordRequestInput: '',
  onPasswordRequestInputChange: vi.fn(),
  passwordRequestSending: false,
  passwordRequestSent: false,
  onPasswordRequestSubmit: vi.fn(),
};

describe('PasswordsSection passkeys row', () => {
  it('renders Apple Passwords and Passkeys under passwords and opens the sync modal from the row button', async () => {
    const user = userEvent.setup();
    const onPasskeysConnect = vi.fn();

    renderWithProviders(<PasswordsSection {...baseProps} onPasskeysOpen={onPasskeysConnect} />);

    const passwordsSection = screen.getByText('Passwords').closest('.rounded-lg')!;
    expect(within(passwordsSection).getByText('Apple Passwords & Passkeys')).toBeInTheDocument();
    expect(within(passwordsSection).queryByText('Apple Passwords')).not.toBeInTheDocument();
    expect(screen.queryByText(/enable rose in autofill/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /connect passkeys/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/add an agent passkey/i)).not.toBeInTheDocument();

    for (const rowIcon of passwordsSection.querySelectorAll('img')) {
      expect(rowIcon).toHaveClass('w-8', 'h-8');
    }

    const passkeysRow = screen.getByTestId('passkeys-sync-row');
    const applePasswordsIcon = passkeysRow.querySelector('img[aria-hidden="true"]');
    expect(applePasswordsIcon).toHaveAttribute(
      'src',
      expect.stringContaining('apple-passwords-icon'),
    );
    expect(applePasswordsIcon).toHaveClass('w-8', 'h-8');
    const iconFrame = applePasswordsIcon?.parentElement;
    expect(iconFrame?.tagName).toBe('DIV');
    expect(iconFrame?.children).toHaveLength(1);
    expect(iconFrame).toHaveClass('border-transparent');
    expect(iconFrame).toHaveClass(
      '[&>*]:h-full',
      '[&>*]:w-full',
      '[&>*]:[object-fit:var(--dropdown-icon-fit)]',
    );
    expect(iconFrame?.getAttribute('style')).toContain('conic-gradient');

    await user.click(
      within(passkeysRow).getByRole('button', { name: /sync apple passwords and passkeys/i }),
    );

    expect(onPasskeysConnect).toHaveBeenCalledTimes(1);
  });

  it('syncs from the passkeys modal without closing before import completion', async () => {
    const user = userEvent.setup();
    const onSync = vi.fn(async () => ({ enabled: true }));

    renderWithProviders(<PasskeysModal isOpen onClose={vi.fn()} onSync={onSync} />);

    expect(screen.getByText('Sync Apple Passwords & Passkeys')).toBeInTheDocument();
    expect(
      screen.getByAltText('System Settings AutoFill and Passwords with the Rose row highlighted'),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText('Passwords File menu with Export All Items to App highlighted'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('passkeys-export-all-items-highlight')).toBeInTheDocument();

    const syncButton = screen.getByRole('button', { name: /^sync$/i });
    expect(syncButton).toHaveClass('bg-foreground');

    await user.click(syncButton);

    expect(onSync).toHaveBeenCalledTimes(1);
    expect((await screen.findAllByText(/Export All Items to App/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Rose is enabled/i)).not.toBeInTheDocument();
    expect(screen.getByText('Sync Apple Passwords & Passkeys')).toBeInTheDocument();
  });

  it('keeps the modal sync button loading while the native import is pending', async () => {
    const user = userEvent.setup();
    let resolveSync: (() => void) | null = null;
    const onSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );

    renderWithProviders(<PasskeysModal isOpen onClose={vi.fn()} onSync={onSync} />);

    await user.click(screen.getByRole('button', { name: /^sync$/i }));

    expect(onSync).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Syncing...')).toBeInTheDocument();

    resolveSync?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /^sync$/i })).toBeEnabled());
  });

  it('allows explicit close controls during sync but blocks backdrop dismissal', async () => {
    const user = userEvent.setup();
    let resolveSync: (() => void) | null = null;
    const onClose = vi.fn();
    const onSync = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSync = resolve;
        }),
    );

    renderWithProviders(<PasskeysModal isOpen onClose={onClose} onSync={onSync} />);

    await user.click(screen.getByRole('button', { name: /^sync$/i }));
    expect(screen.getByText('Syncing...')).toBeInTheDocument();

    await user.click(screen.getByTestId('passkeys-modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(2);

    resolveSync?.();
    await waitFor(() => expect(screen.getByRole('button', { name: /^sync$/i })).toBeEnabled());
  });

  it('uses the credential exchange flow instead of the CSV import modal', () => {
    renderWithProviders(
      <PasskeysModal isOpen onClose={vi.fn()} onSync={vi.fn(async () => ({ enabled: true }))} />,
    );

    expect(screen.getByText('Sync Apple Passwords & Passkeys')).toBeInTheDocument();
    expect(screen.queryByText('Import Apple Passwords')).not.toBeInTheDocument();
    expect(screen.queryByText(/export all passwords/i)).not.toBeInTheDocument();
  });
});
