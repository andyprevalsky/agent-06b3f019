/**
 * STATE MACHINE: mountBlurLab
 *
 * [OFF] (no ?blurlab=1, no session flag, or Electron) --> nothing loaded
 * [ON] --> dynamic-import BlurLab, mount into #blur-lab-portal
 */
import { createRoot } from 'react-dom/client';

import { shouldActivateBlurLab } from './blurLabEffects';

export function mountBlurLabIfRequested(): void {
  if (!shouldActivateBlurLab()) return;
  void import('./BlurLab').then(({ default: BlurLab }) => {
    const host = document.createElement('div');
    host.id = 'blur-lab-portal';
    document.body.appendChild(host);
    createRoot(host).render(<BlurLab />);
  });
}
