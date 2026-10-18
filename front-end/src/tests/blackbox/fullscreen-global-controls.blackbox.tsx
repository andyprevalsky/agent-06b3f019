import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, within, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppShell from '@/features/app-wiring/components/AppShell';

vi.mock('@/features/app-wiring/config', async (importOriginal) => {
  const actual = await importOriginal<object>();
  const { useState, useEffect } = await import('react');
  const { MobileFrameHeader } =
    await import('@/features/terminal-component-group/components/browser-status-bar/BrowserFullscreenHeaders');
  const { InspectionAccountBadge } =
    await import('@/features/terminal/components/InspectionAccountBadge');
  function Page() {
    const [open, setOpen] = useState(false);
    useEffect(() => {
      const openView = () => setOpen(true);
      const closeView = () => setOpen(false);
      window.addEventListener('fixture-open-phone', openView);
      window.addEventListener('fixture-close-phone', closeView);
      return () => {
        window.removeEventListener('fixture-open-phone', openView);
        window.removeEventListener('fixture-close-phone', closeView);
      };
    }, []);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open phone view</button>
        <InspectionAccountBadge
          context={{ user_id: 'target', name: 'Ada Lovelace', phone: '+15555550101', email: null }}
        />
        {open && (
          <section aria-label="Fullscreen phone">
            <MobileFrameHeader
              controlState="active"
              isUserControlling={false}
              onClose={() => setOpen(false)}
            />
            <div data-testid="phone-pixels">Phone pixels</div>
          </section>
        )}
      </>
    );
  }
  return { ...actual, ROUTE_TABLE: [{ path: '*', component: Page }] };
});

beforeEach(() => {
  localStorage.clear();
  const session = (token: string, id: string) => ({
    access_token: token,
    refresh_token: 'fixture',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id, is_anonymous: false },
  });
  localStorage.setItem('rose-session', JSON.stringify(session('target-token', 'target')));
  localStorage.setItem('rose-admin-session', JSON.stringify(session('admin-token', 'admin')));
  localStorage.setItem(
    'rose-impersonation',
    JSON.stringify({
      userId: 'target',
      name: 'Ada Lovelace',
      email: null,
      phone: null,
      isAdmin: false,
    }),
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('reserves fullscreen header space for the same reachable impersonation and read-only controls, then restores them', async () => {
  const user = userEvent.setup();
  render(<AppShell />);
  const rail = screen.getByTestId('top-right-controls');
  const badge = screen.getByTestId('inspection-account-badge');
  await user.click(screen.getByRole('button', { name: 'Switch account' }));
  const search = screen.getByRole('searchbox', { name: 'Search accounts' });
  await user.type(search, 'Ada');
  act(() => window.dispatchEvent(new Event('fixture-open-phone')));
  const fullscreen = screen.getByRole('region', { name: 'Fullscreen phone' });
  expect(fullscreen).toContainElement(rail);
  const slot = within(fullscreen).getByTestId('fullscreen-global-controls-slot');
  expect(slot).toContainElement(rail);
  expect(slot.parentElement?.nextElementSibling).toBe(screen.getByTestId('phone-pixels'));
  expect(screen.getByTestId('inspection-account-badge')).toBe(badge);
  expect(badge).toHaveAttribute('aria-label', expect.stringContaining('read-only'));
  expect(within(fullscreen).getByRole('button', { name: 'Return to my account' })).toBeVisible();
  expect(screen.getByRole('searchbox', { name: 'Search accounts' })).toBe(search);
  expect(search).toHaveValue('Ada');
  expect(screen.getByRole('button', { name: 'Close browser view' })).toBeVisible();
  act(() => window.dispatchEvent(new Event('fixture-close-phone')));
  expect(screen.getByTestId('top-right-controls')).toBe(rail);
  expect(screen.getByRole('searchbox', { name: 'Search accounts' })).toBe(search);
  expect(search).toHaveValue('Ada');
  expect(rail.closest('[data-testid="fullscreen-global-controls-slot"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Return to my account' })).toBeVisible();
});
