/**
 * STATE MACHINE: RoseAppDrawers
 *
 * Both drawer shells stay mounted (portaled to <body>) so they can slide in
 * and out:
 *   openApp === 'browser' -> BrowserAppDrawer open, VoiceAppDrawer closed
 *   openApp === 'voice'   -> VoiceAppDrawer open, BrowserAppDrawer closed
 *   openApp === null      -> both closed
 * The Voice drawer renders its body lazily on first open (see VoiceAppDrawer).
 */

import { BrowserAppDrawer } from './BrowserAppDrawer';
import { VoiceAppDrawer } from './VoiceAppDrawer';

export function RoseAppDrawers() {
  return (
    <>
      <BrowserAppDrawer />
      <VoiceAppDrawer />
    </>
  );
}
