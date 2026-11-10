/**
 * Blackbox tests for the Rose Desktop Phone app (UI ledger rows 66/86).
 *
 * With no agent selected the Phone app is the floating iPhone in DEVICE VIEW:
 *  - flag on: opening it shows the device (no header, card or controls) and the
 *    read-only device view; it reads only /iphone/device(+/frame) and
 *    /iphone/connection: never a lease, interaction or /api/phones request
 *  - its icon again / Escape closes it and stops every read
 *  - flag off: nothing renders and nothing is requested
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { capturedRequests } from './msw/capture';
import { renderWithProviders } from './test-wrapper';

import { RoseAppIcons } from '@/features/terminal-component-group';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

const phoneRequests = () =>
  capturedRequests.filter((r) => /^\/api\/(phones|iphone)(\/|$)/.test(new URL(r.url).pathname));
/** Device view reads: account-level, lease-free. */
const DEVICE_READ = /^\/api\/iphone\/(device|device\/frame|connection)$/;
const nonDeviceRequests = () =>
  phoneRequests().filter((r) => !DEVICE_READ.test(new URL(r.url).pathname));

/** Let any request the Phone might start reach the MSW capture on the real clock. */
async function settle(ms = 50) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => mockSession());

describe('Rose Desktop Phone (device view by default)', () => {
  it('shows the floating iPhone with the read-only device view and no controls', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-phone'));

    const phone = screen.getByTestId('rose-phone');
    const device = within(phone).getByTestId('rose-phone-device');
    const screenEl = within(device).getByTestId('phone-screen');
    expect(screenEl).toHaveAttribute('data-mode', 'device');
    expect(within(screenEl).getByTestId('phone-device-view')).toHaveAttribute('data-amp-block');
    // Default MSW device: not enabled for this account.
    expect(
      await within(screenEl).findByText('Phone access requires the connected phone service.'),
    ).toBeInTheDocument();
    // Floating device only: no buttons, frame image, overlay or connect message.
    expect(within(phone).queryAllByRole('button')).toHaveLength(0);
    expect(within(phone).queryByTestId('phone-frame')).toBeNull();
    expect(within(phone).queryByTestId('phone-agent-overlay')).toBeNull();
    expect(phone).not.toHaveTextContent(/Take control|Connect your iPhone/);
    // 24px from the right edge, vertically centered, nothing behind the device.
    expect(phone.style.right).toBe('24px');
    expect(phone.style.top).toBe('50%');
    expect(phone.className).not.toMatch(/\bbg-/);
  });

  it('reads only the device view while open and stops reading once closed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />);
    await user.click(screen.getByTestId('rose-app-phone'));
    expect(screen.getByTestId('rose-phone')).toBeInTheDocument();
    await waitFor(() =>
      expect(phoneRequests().some((r) => new URL(r.url).pathname === '/api/iphone/device')).toBe(
        true,
      ),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    await user.click(screen.getByTestId('rose-app-phone'));
    expect(screen.getByTestId('phone-device-view')).toBeInTheDocument();
    await user.click(screen.getByTestId('rose-app-phone'));
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    await settle();
    const closed = phoneRequests().length;
    await settle(3_500);
    expect(phoneRequests()).toHaveLength(closed);
    expect(nonDeviceRequests()).toHaveLength(0);
  });

  it('flag off: opening the Phone renders nothing and requests nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RoseAppIcons />, { roseDesktop: false });
    await user.click(screen.getByTestId('rose-app-phone'));
    await settle();
    expect(screen.queryByTestId('rose-phone')).toBeNull();
    expect(phoneRequests()).toHaveLength(0);
  });
});
