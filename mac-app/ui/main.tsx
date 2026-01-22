import { createRoot } from 'react-dom/client';
import ElectronApp from './ElectronApp';
import UpdateIndicator from './UpdateIndicator';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { IntegrationHandlersProvider } from '@/contexts/IntegrationHandlersContext';
import { dispatchQuickQueryEvent } from '@/lib/quickQuery';
import './fonts.css';
import '@/index.css';
import React, { useEffect } from 'react';
import type { QuickQueryPayload } from '../shared/types/ipc';

// Electron-specific integration handlers
const electronHandlers = {
  iMessage: {
    isAvailable: true,
    onClick: async () => {
      const hasAccess = await window.api.checkIMessageAccess();
      if (!hasAccess) {
        throw new Error('Grant Full Disk Access in System Preferences → Privacy & Security → Full Disk Access');
      }
      const result = await window.api.startIMessageUpload();
      if (!result.success) {
        throw new Error(result.message || 'Upload failed');
      }
    },
  },
  chromeCookies: {
    isAvailable: true,
    onClick: async () => {
      const cookies = await window.api.readChromeCookies();
      const result = await window.api.uploadCookies(cookies);
      if (!result.success) {
        throw new Error(result.message || 'Upload failed');
      }
    },
  },
  browserCookies: {
    isAvailable: true,
    getInstalledBrowsers: async () => {
      return window.api.getInstalledBrowsers();
    },
    syncBrowser: async (browserType: string, keychainPassword?: string) => {
      const cookies = await window.api.readBrowserCookies(
        browserType as import('../shared/types/ipc').BrowserType,
        keychainPassword ? { keychainPassword } : undefined
      );
      if (cookies.length > 0) {
        const result = await window.api.uploadBrowserCookies(
          browserType as import('../shared/types/ipc').BrowserType,
          cookies
        );
        if (!result.success) {
          throw new Error(result.message || 'Upload failed');
        }
      }
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
  <div
    style={
      {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '48px',
        zIndex: 9999,
        pointerEvents: 'none',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties
    }
  />
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
