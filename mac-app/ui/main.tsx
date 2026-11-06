import { createRoot } from 'react-dom/client';
import ElectronApp from './features/electron-app';
import UpdateIndicator from './features/update-indicator';
import WhatsAppQRModal from './features/whats-app-qr-modal';
import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { IntegrationHandlersProvider } from '@/features/integration-handlers-context';
import './fonts.css';
import '@/index.css';
import React, { useMemo } from 'react';
import type { BrowserType } from '../shared/types/ipc';
import { getElectronApi } from './lib/electron-api';
import { useWhatsAppConnect } from './lib/useWhatsAppConnect';
import { initViewportScale } from './lib/viewport-scale';
import QuickQueryListener from './features/quick-query-listener';
import { mirrorDocumentTheme } from './shared/theme-sync';

initViewportScale();
// The Quick-Query launcher window follows this window's html.dark.
mirrorDocumentTheme();

// Electron-specific integration handlers
const electronHandlers = {
  iMessage: {
    isAvailable: Boolean(getElectronApi()),
    onClick: async () => {
      const api = getElectronApi();
      if (!api) throw new Error('Desktop bridge is not available');
      const hasAccess = await api.checkIMessageAccess();
      if (!hasAccess) {
        throw new Error(
          'Grant Full Disk Access in System Preferences → Privacy & Security → Full Disk Access'
        );
      }
      const result = await api.startIMessageUpload();
      if (!result.success) {
        throw new Error(result.message ?? 'Upload failed');
      }
    },
  },
  chromeCookies: {
    isAvailable: Boolean(getElectronApi()),
    onClick: async () => {
      const api = getElectronApi();
      if (!api) throw new Error('Desktop bridge is not available');
      const cookies = await api.readChromeCookies();
      const result = await api.uploadCookies(cookies);
      if (!result.success) {
        throw new Error(result.message ?? 'Upload failed');
      }
    },
  },
  claudeCode: {
    isAvailable: Boolean(getElectronApi()),
    hasCredentials: () => getElectronApi()?.claudeCode?.hasCredentials() ?? Promise.resolve(false),
    syncCredentials: () =>
      getElectronApi()?.claudeCode?.syncCredentials() ??
      Promise.resolve({ success: false, message: 'Not available' }),
  },
  gptCode: {
    isAvailable: true,
    hasCredentials: () => window.api.gptCode?.hasCredentials() ?? Promise.resolve(false),
    syncCredentials: () =>
      window.api.gptCode?.syncCredentials() ??
      Promise.resolve({ success: false, message: 'Not available' }),
  },
  passkeys: {
    isAvailable: Boolean(getElectronApi()),
    openAutoFillSettings: () =>
      getElectronApi()?.openAutoFillSettings() ?? Promise.resolve({ success: false }),
    checkAutoFillSettings: () =>
      getElectronApi()?.checkAutoFillSettings() ?? Promise.resolve({ success: false }),
    openPasswordsApp: () =>
      getElectronApi()?.openPasswordsApp() ??
      Promise.resolve({ success: false, message: 'Desktop bridge is not available' }),
    onImportComplete: (
      callback: (result: {
        success: boolean;
        count?: number;
        passkeyCount?: number;
        passwordCount?: number;
        message?: string;
      }) => void
    ) => getElectronApi()?.onPasskeysImportComplete?.(callback) ?? (() => {}),
    enroll: (params: { url: string; rpMatch?: string }) =>
      getElectronApi()?.passkeys?.enroll(params) ??
      Promise.resolve({ success: false, message: 'Desktop bridge is not available' }),
  },
  browserCookies: {
    isAvailable: Boolean(getElectronApi()),
    getInstalledBrowsers: async () => {
      return getElectronApi()?.getInstalledBrowsers() ?? [];
    },
    // Full browser-state sync (cookies + history + fingerprint) — the same
    // path onboarding has always used, not just a cookie upload.
    syncBrowser: async (browserType: string, keychainPassword?: string) => {
      const api = getElectronApi();
      if (!api) throw new Error('Desktop bridge is not available');
      const result = await api.syncBrowser(
        browserType as BrowserType,
        keychainPassword !== undefined && keychainPassword !== '' ? { keychainPassword } : undefined
      );
      if (!result.success) {
        throw new Error(result.message ?? 'Sync failed');
      }
    },
    syncBrowserPasswords: async (browserType: string, config?: { keychainPassword?: string }) => {
      return (
        getElectronApi()?.syncBrowserPasswords(browserType as BrowserType, config) ??
        Promise.resolve({ success: false })
      );
    },
    storeAtlasPassword: async (password: string) => {
      const api = getElectronApi();
      if (api?.atlas?.storePassword) {
        return api.atlas.storePassword(password);
      }
      return { success: false, error: 'Atlas password storage not available' };
    },
    openKeychainAccess: async (searchQuery?: string) => {
      return getElectronApi()?.openKeychainAccess(searchQuery) ?? { success: false };
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

/**
 * WhatsApp pairing needs React state (the QR streams in over IPC while
 * `connect()` is still pending), so its handler is composed here rather than in
 * the module-level `electronHandlers` literal. The modal lives alongside the
 * provider so the shared Integrations row can trigger pairing without the shared
 * front-end depending on any QR rendering.
 */
const Root = () => {
  const whatsApp = useWhatsAppConnect();
  const handlers = useMemo(
    () => ({
      ...electronHandlers,
      whatsApp: { isAvailable: whatsApp.isAvailable, connect: whatsApp.connect },
    }),
    [whatsApp.isAvailable, whatsApp.connect]
  );

  return (
    <IntegrationHandlersProvider handlers={handlers}>
      <>
        <DragOverlay />
        <ElectronApp />
        <UpdateIndicator />
        <QuickQueryListener />
        <WhatsAppQRModal
          isOpen={whatsApp.isModalOpen}
          onClose={whatsApp.closeModal}
          qrCode={whatsApp.qrCode}
          isConnecting={whatsApp.isConnecting}
        />
      </>
    </IntegrationHandlersProvider>
  );
};

// Render main app with electron handlers
createRoot(document.getElementById('root')!).render(<Root />);

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
