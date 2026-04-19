import { createRoot } from 'react-dom/client';
import ElectronApp from './features/electron-app';
import UpdateIndicator from './UpdateIndicator';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import { dispatchQuickQueryEvent } from '@/lib/quickQuery';
import './fonts.css';
import '@/index.css';
import React, { useEffect } from 'react';
import type { BrowserType, QuickQueryPayload } from '../shared/types/ipc';

// Electron-specific integration handlers
const electronHandlers = {
  iMessage: {
    isAvailable: true,
    onClick: async () => {
      const hasAccess = await window.api.checkIMessageAccess();
      if (!hasAccess) {
        throw new Error(
          'Grant Full Disk Access in System Preferences → Privacy & Security → Full Disk Access'
        );
      }
      const result = await window.api.startIMessageUpload();
      if (!result.success) {
        throw new Error(result.message ?? 'Upload failed');
      }
    },
  },
  chromeCookies: {
    isAvailable: true,
    onClick: async () => {
      const cookies = await window.api.readChromeCookies();
      const result = await window.api.uploadCookies(cookies);
      if (!result.success) {
        throw new Error(result.message ?? 'Upload failed');
      }
    },
  },
  claudeCode: {
    isAvailable: true,
    hasCredentials: () => window.api.claudeCode?.hasCredentials() ?? Promise.resolve(false),
    syncCredentials: () =>
      window.api.claudeCode?.syncCredentials() ??
      Promise.resolve({ success: false, message: 'Not available' }),
  },
  browserCookies: {
    isAvailable: true,
    getInstalledBrowsers: async () => {
      return window.api.getInstalledBrowsers();
    },
    syncBrowser: async (browserType: string, keychainPassword?: string) => {
      const cookies = await window.api.readBrowserCookies(
        browserType as BrowserType,
        keychainPassword !== undefined && keychainPassword !== '' ? { keychainPassword } : undefined
      );
      if (cookies.length > 0) {
        const result = await window.api.uploadBrowserCookies(browserType as BrowserType, cookies);
        if (!result.success) {
          throw new Error(result.message ?? 'Upload failed');
        }
      }
    },
    syncBrowserPasswords: async (browserType: string, config?: { keychainPassword?: string }) => {
      return window.api.syncBrowserPasswords(browserType as BrowserType, config);
    },
    storeAtlasPassword: async (password: string) => {
      if (window.api.atlas?.storePassword) {
        return window.api.atlas.storePassword(password);
      }
      return { success: false, error: 'Atlas password storage not available' };
    },
    openKeychainAccess: async (searchQuery?: string) => {
      return window.api.openKeychainAccess(searchQuery);
    },
  },
};

const DragOverlay = () => (
  <>
    {/* Thin strip above the header (top-4 = 16px gap) for window dragging */}
    <div
      style={
        {
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: '16px',
          zIndex: 9999,
          WebkitAppRegion: 'drag',
        } as React.CSSProperties
      }
    />
    {/* Make header a drag region; buttons inside get no-drag as children */}
    <style>{`
      header { -webkit-app-region: drag; }
      header button, header a, header [role="button"], header input { -webkit-app-region: no-drag; }
    `}</style>
  </>
);

// Render main app with electron handlers
createRoot(document.getElementById('root')!).render(
  <IntegrationHandlersProvider handlers={electronHandlers}>
    <>
      <DragOverlay />
      <ElectronApp />
      <UpdateIndicator />
      <QuickQueryListener />
    </>
  </IntegrationHandlersProvider>
);

function QuickQueryListener() {
  useEffect(() => {
    const handler = (payload: QuickQueryPayload) => {
      dispatchQuickQueryEvent(payload);
    };

    window.api.onQuickQuerySubmit(handler);
  }, []);

  return null;
}

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
