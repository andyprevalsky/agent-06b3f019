/**
 * STATE MACHINE: UserUiShell
 *
 *   no shell / safe mode → children (stock app chrome)
 *   shell published      → full-viewport frame INSTEAD of the app chrome;
 *                          SafeModeControl (rendered by the provider) stays above
 *
 * The named whole-app slots (background, sidebar.header, menu, home.dashboard,
 * agent.panel) were removed (UI ledger row 89); a manifest that still lists
 * them mounts nothing.
 */
import type { ReactNode } from 'react';

import { useUserUi } from '../hooks';
import { UserUiFrame } from './UserUiFrame';

export function UserUiShell({ children }: { children: ReactNode }) {
  const { shellUrl } = useUserUi();
  if (!shellUrl) return <>{children}</>;
  return (
    <div
      data-testid="user-ui-shell"
      className="fixed inset-0 h-screen w-screen bg-background"
      style={{ height: '100dvh' }}
    >
      <UserUiFrame
        src={shellUrl}
        title="Rose"
        testId="user-ui-shell-frame"
        className="block h-full w-full"
      />
    </div>
  );
}
