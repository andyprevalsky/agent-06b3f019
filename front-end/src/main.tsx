/**
 * STATE MACHINE: main.tsx (Entry Point)
 *
 * This is the app entry point - no component state.
 * Initializes external services and renders the root React tree.
 *
 * [INIT] --> Initialize Amplitude analytics
 *   |
 *   v
 * [SET_VH] --> Set CSS viewport height variable
 *   |
 *   v
 * [RENDER] --> Mount <App /> and <Toaster /> to DOM
 *   |
 *   v
 * [LISTENING] --> Event listeners for resize/orientation/visibility
 */

import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { Toaster } from '@/components/ui/toaster'
import { Toaster as Sonner } from '@/components/ui/sonner'
import { IntegrationHandlersProvider } from '@/contexts/IntegrationHandlersContext'
import './index.css'

// Dev-only console log capture (sends to backend for file logging)
if (import.meta.env.DEV) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  const sendLog = (level: string, args: unknown[]) => {
    fetch('http://localhost:3001/api/dev/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        args: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a))
      })
    }).catch(() => {}); // Silently fail if backend unavailable
  };

  console.log = (...args) => { originalLog(...args); sendLog('log', args); };
  console.warn = (...args) => { originalWarn(...args); sendLog('warn', args); };
  console.error = (...args) => { originalError(...args); sendLog('error', args); };
}

// Log environment mode at startup (after capture setup so it goes to log file)
console.log(`🚀 [Frontend] Mode: ${import.meta.env.DEV ? 'DEVELOPMENT' : 'PRODUCTION'}`);

// Amplitude Analytics
import * as amplitude from '@amplitude/analytics-browser';
import { sessionReplayPlugin } from '@amplitude/plugin-session-replay-browser';

// Initialize Amplitude with Session Replay
amplitude.add(sessionReplayPlugin({ sampleRate: 1 }));
amplitude.init('ff5280db0f34594af90323d5ef9e3e34', { autocapture: true });

// Fix iOS Safari viewport height issues
const setVH = () => {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
};

// Set initial value
setVH();

// Update on resize and orientation change
window.addEventListener('resize', setVH);
window.addEventListener('orientationchange', () => {
  setTimeout(setVH, 100);
});

// Handle iOS Safari viewport changes more aggressively
if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
  // Handle Safari's dynamic UI
  if (window.visualViewport) {
    const updateVH = () => {
      const vh = window.visualViewport!.height * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    
    window.visualViewport.addEventListener('resize', updateVH);
    window.visualViewport.addEventListener('scroll', updateVH);
  }
  
  // Additional iOS specific events
  window.addEventListener('focus', () => setTimeout(setVH, 100));
  window.addEventListener('blur', () => setTimeout(setVH, 100));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(setVH, 100);
  });
}

// Render main app
createRoot(document.getElementById("root")!).render(
  <IntegrationHandlersProvider>
    <App />
  </IntegrationHandlersProvider>
);

// Render toasters outside of root to avoid z-index stacking context issues
const toasterContainer = document.createElement('div');
toasterContainer.id = 'toaster-portal';
document.body.appendChild(toasterContainer);
createRoot(toasterContainer).render(
  <>
    <Toaster />
    <Sonner />
  </>
);
