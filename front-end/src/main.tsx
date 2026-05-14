/**
 * STATE MACHINE: main.tsx (Entry Point)
 *
 * Thin wiring file — delegates all initialization to features/app-wiring.
 *
 * [INIT] --> initDevLogging, logStartupMode, initAmplitude
 *        --> initViewportHeight, initViewportScale
 *   |
 *   v
 * [RENDER] --> Mount <AppShell /> with providers + toasters to DOM
 */

import { createRoot } from 'react-dom/client';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import AppShell, {
  initDevLogging,
  initAmplitude,
  initViewportHeight,
  initViewportScale,
  logStartupMode,
} from '@/features/app-wiring';
import './index.css';

// Bootstrap side-effects (dev logging, analytics, viewport height)
initDevLogging();
logStartupMode();
initAmplitude();
initViewportHeight();
initViewportScale();

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
