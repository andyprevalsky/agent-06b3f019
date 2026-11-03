/**
 * STATE MACHINE: AccountSwitcher
 *
 * [MOUNTED] --> delegates to the app-wiring AdminSwitcherMount in its Settings
 * placement: the inline admin account switcher of the Rose Desktop Settings
 * panel (renders nothing for non-admins who are not impersonating).
 */

import { AdminSwitcherMount } from '@/features/app-wiring/components/AdminSwitcherMount';

export default function AccountSwitcher() {
  return <AdminSwitcherMount placement="settings" />;
}
