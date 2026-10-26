/**
 * STATE MACHINE: AdminSwitcherMount
 *
 * [MOUNTED] --> resolves the signed-in identity --> <AdminAccountSwitcher/>
 *   the switcher itself decides whether to render (admin, or mid-impersonation).
 *
 * placement:
 *   top-right (default, AppShell's TopRightControls rail on every route)
 *     stock accounts          → the floating pill, unchanged
 *     Rose Desktop accounts   → no pill on their own account (the top-right
 *       (lib/roseDesktop.ts)     corner holds only the 4 bare app icons; the
 *                                switcher lives in Settings); while
 *                                impersonating the pill returns as the exit
 *   settings (Rose Desktop Settings panel, via pages/AccountSwitcher)
 *     → the inline switcher section (admins / impersonating viewers only)
 *
 * Mounted at the app shell rather than inside the terminal so the pill is
 * reachable from EVERY route — including ones an impersonated account lands on
 * that have no terminal chrome, where it would otherwise be the missing exit.
 * app-wiring is the sanctioned place to compose feature entry points.
 */

import { AdminAccountSwitcher } from '@/features/admin-account-switcher';
import { useAuth } from '@/features/auth';
import { ADMIN_PHONE_DIGITS } from '@/features/terminal-component-group/config';
import { ADMIN_USER_IDS } from '@/lib/adminAccounts';
import { isRoseDesktopUser } from '@/lib/roseDesktop';

function isAdminUser(user: { id?: string; phone?: string } | null): boolean {
  if (!user) return false;
  if (user.id && ADMIN_USER_IDS.includes(user.id)) return true;
  const phoneDigits = (user.phone ?? '').replace(/\D/g, '');
  return ADMIN_PHONE_DIGITS.includes(phoneDigits);
}

/** Best available human label for the signed-in account, shown on the admin pill. */
function accountLabel(user: { id?: string; phone?: string; email?: string } | null): string | null {
  if (!user) return null;
  const phone = user.phone?.trim();
  if (phone !== undefined && phone !== '') return phone;
  const email = user.email?.trim();
  if (email !== undefined && email !== '') return email;
  return user.id?.slice(0, 8) ?? null;
}

export type AdminSwitcherPlacement = 'top-right' | 'settings';

export function AdminSwitcherMount({
  placement = 'top-right',
}: {
  placement?: AdminSwitcherPlacement;
} = {}) {
  // Passive: this component only READS the signed-in identity. A non-passive
  // useAuth() starts a second auth instance and registers another
  // AUTH_SESSION_CHANGED_EVENT listener — and since this is always mounted in
  // AppShell, that would race the app's real auth owner during login/session init.
  const { user } = useAuth({ passive: true });
  if (placement === 'settings') {
    return (
      <AdminAccountSwitcher
        variant="inline"
        isAdmin={isAdminUser(user)}
        ownAccountLabel={accountLabel(user)}
      />
    );
  }
  return (
    <AdminAccountSwitcher
      isAdmin={isAdminUser(user)}
      ownAccountLabel={accountLabel(user)}
      pillOnlyWhileAway={isRoseDesktopUser(user)}
    />
  );
}
