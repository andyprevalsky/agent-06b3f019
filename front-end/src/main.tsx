/**
 * STATE MACHINE: main.tsx (Entry Point)
 *
 * Thin wiring file — delegates all initialization to features/app-wiring.
 *
 * [CAPTURE] --> startPreviewHandoff (strip #rose_preview_handoff, begin redeem),
 *               captureBenchmarkShareToken — both before anything logs the URL
 *   |
 *   v
 * [INIT] --> initDevLogging, logStartupMode, initAmplitude
 *        --> initViewportHeight, initViewportScale
 *        --> initAppVersionWatch (reload a resumed page onto a newer deploy)
 *   |
 *   |-- preview handoff in flight --> [WAIT_HANDOFF] --settled--> [RENDER]
 *   v
 * [RENDER] --> Mount <AppShell /> with providers + toasters to DOM
 */

import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import { initAppVersionWatch } from '@/lib/appVersion';
import { captureBenchmarkShareToken } from '@/lib/benchmarkShare';
import { mountBlurLabIfRequested } from '@/dev/blur-lab/mountBlurLab';
import { initThemeColorSync } from '@/lib/themeColor';
import { startPreviewHandoff } from '@/lib/previewHandoff';
import AppShell, {
  initDevLogging,
  initAmplitude,
  initViewportHeight,
  initViewportScale,
  logStartupMode,
} from '@/features/app-wiring';
import './index.css';

// Bootstrap side-effects (dev logging, analytics, viewport height). Bearer
// fragments are removed first so neither logging nor analytics sees them.
const previewHandoff = startPreviewHandoff();
captureBenchmarkShareToken();
initDevLogging();
logStartupMode();
initAmplitude();
initViewportHeight();
initViewportScale();
initAppVersionWatch();
initThemeColorSync();
mountBlurLabIfRequested();

function renderApp(): void {
  // Render main app
  createRoot(document.getElementById('root')!).render(
    <IntegrationHandlersProvider>
      <AppShell />
    </IntegrationHandlersProvider>,
  );

  // Render toasters outside of root to avoid z-index stacking context issues
  const toasterContainer = document.createElement('div');
  toasterContainer.id = 'toaster-portal';
  document.body.appendChild(toasterContainer);
  createRoot(toasterContainer).render(
    <>
      <Toaster />
      <Sonner />
    </>,
  );
}

// A preview sign-in link must land its session before auth initializes, or
// initAuthSession would race it with an anonymous session / dev auto-login.
if (previewHandoff === null) renderApp();
else void previewHandoff.finally(renderApp);
