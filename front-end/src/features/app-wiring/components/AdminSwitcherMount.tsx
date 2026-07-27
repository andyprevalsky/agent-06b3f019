/**
 * STATE MACHINE: AdminSwitcherMount
 *
 * [MOUNTED] --> resolves the signed-in identity --> <AdminAccountSwitcher/>
 *   the switcher itself decides whether to render (admin, or mid-impersonation).
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

export function AdminSwitcherMount() {
  const { user } = useAuth();
  return <AdminAccountSwitcher isAdmin={isAdminUser(user)} ownAccountLabel={accountLabel(user)} />;
}
