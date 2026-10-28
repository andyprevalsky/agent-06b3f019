/**
 * Renderer entry for the Quick-Query launcher window.
 *
 * Referenced directly by `launcher.html` (Vite entry). Kept as a thin shell
 * that injects the launcher's global reset CSS and mounts the feature's
 * `<Launcher>` component under `AppDataProvider`. All behavior lives in
 * `ui/features/launcher/` — see that barrel for the feature surface.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { AppDataProvider } from '@/hooks/useAppData';
import { Launcher, LAUNCHER_GLOBAL_CSS } from '../features/launcher';
import { initViewportScale } from '../lib/viewport-scale';
import { followMirroredTheme } from '../shared/theme-sync';

initViewportScale();
// Separate BrowserWindow: adopt the main window's html.dark (see shared/theme-sync).
followMirroredTheme();

// Styles - must override Tailwind's bg-background
const style = document.createElement('style');
style.textContent = LAUNCHER_GLOBAL_CSS;
document.head.appendChild(style);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppDataProvider>
      <Launcher />
    </AppDataProvider>
  </React.StrictMode>
);
