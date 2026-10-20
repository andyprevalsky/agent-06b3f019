/**
 * STATE MACHINE: RoseAppDrawers
 *
 * The drawer shell stays mounted (portaled to <body>) so it can slide in/out:
 *   openApp === 'browser' -> BrowserAppDrawer open
 *   openApp === null      -> closed
 */

import { BrowserAppDrawer } from './BrowserAppDrawer';

export function RoseAppDrawers() {
  return <BrowserAppDrawer />;
}
