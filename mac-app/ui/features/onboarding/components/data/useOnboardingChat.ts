/**
 * STATE MACHINE: useOnboardingChat
 *
 * WhatsApp: [IDLE] --connect--> [CHECK_CREDENTIALS] --has creds--> [CONNECTED]
 *                             \--no creds--> [QR_MODAL] --scan--> [CONNECTED]
 * Telegram: [IDLE] --connect--> [ALREADY_CONNECTED? resync] | [SESSION? reconnect]
 *                             \--no session--> [AUTH_MODAL] --code--> [CONNECTED]
 *
 * System context:
 *   OnboardingData -> useOnboardingChat: mac-app-only WhatsApp/Telegram flows
 *   (window.api bridge + QR/auth modals). The web integrations page lists
 *   these as coming soon, so no shared front-end hook exists to reuse.
 */

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

type ChatSyncType = 'whatsapp' | 'telegram';

export interface OnboardingChatState {
  chatSyncLoading: ChatSyncType | null;
  whatsAppQRModalOpen: boolean;
  whatsAppQRCode: string | null;
  telegramAuthModalOpen: boolean;
  whatsAppJustConnected: boolean;
  telegramJustConnected: boolean;
  handleWhatsAppConnect: () => Promise<void>;
  handleTelegramConnect: () => Promise<void>;
  closeWhatsAppQRModal: () => void;
  closeTelegramAuthModal: () => void;
  onTelegramAuthSuccess: () => void;
}

interface WhatsAppCtx {
  fetchIntegrations: () => Promise<void>;
  qrCleanupRef: MutableRefObject<(() => void) | null>;
  setQRCode: (qr: string | null) => void;
  setQRModalOpen: (open: boolean) => void;
  setJustConnected: (connected: boolean) => void;
}

function clearWhatsAppQRListener(ref: MutableRefObject<(() => void) | null>): void {
  ref.current?.();
  ref.current = null;
}

async function connectWhatsApp(ctx: WhatsAppCtx): Promise<void> {
  clearWhatsAppQRListener(ctx.qrCleanupRef);
  const whatsapp = window.api.whatsapp;
  if (whatsapp === undefined) throw new Error('WhatsApp is unavailable in this app version.');
  const hasCredentials = await whatsapp.hasCredentials();
  if (hasCredentials) {
    const result = await whatsapp.connect();
    if (result.success) {
      ctx.setJustConnected(true);
      await ctx.fetchIntegrations();
      return;
    }
  }
  if (window.api.onWhatsAppQRCode !== undefined) {
    clearWhatsAppQRListener(ctx.qrCleanupRef);
    ctx.qrCleanupRef.current = window.api.onWhatsAppQRCode((qr: string) => ctx.setQRCode(qr));
  }
  ctx.setQRModalOpen(true);
  try {
    const result = await whatsapp.connect();
    if (!result.success) {
      throw new Error(result.error ?? 'WhatsApp connection failed. Please try again.');
    }
    ctx.setJustConnected(true);
    ctx.setQRModalOpen(false);
    ctx.setQRCode(null);
    await ctx.fetchIntegrations();
  } catch (error) {
    ctx.setQRModalOpen(false);
    ctx.setQRCode(null);
    throw error;
  } finally {
    clearWhatsAppQRListener(ctx.qrCleanupRef);
  }
}

interface TelegramCtx {
  fetchIntegrations: () => Promise<void>;
  setAuthModalOpen: (open: boolean) => void;
  setJustConnected: (connected: boolean) => void;
}

async function connectTelegram(ctx: TelegramCtx): Promise<void> {
  const telegram = window.api.telegram;
  if (telegram === undefined) throw new Error('Telegram is unavailable in this app version.');
  const isConnected = await telegram.isConnected();
  if (isConnected) {
    const result = await telegram.syncHistorical();
    if (!result.success) {
      throw new Error(result.error ?? 'Telegram sync failed. Please try again.');
    }
    console.log(`Telegram resync complete: ${result.count ?? 0} messages`);
    ctx.setJustConnected(true);
    return;
  }
  const hasSession = await telegram.hasSession();
  if (hasSession) {
    const result = await telegram.connectWithExistingSession();
    if (result.success) {
      ctx.setJustConnected(true);
      await ctx.fetchIntegrations();
      return;
    }
  }
  ctx.setAuthModalOpen(true);
}

export function useOnboardingChat(fetchIntegrations: () => Promise<void>): OnboardingChatState {
  const [chatSyncLoading, setChatSyncLoading] = useState<ChatSyncType | null>(null);
  const [whatsAppQRModalOpen, setWhatsAppQRModalOpen] = useState(false);
  const [whatsAppQRCode, setWhatsAppQRCode] = useState<string | null>(null);
  const [telegramAuthModalOpen, setTelegramAuthModalOpen] = useState(false);
  const [whatsAppJustConnected, setWhatsAppJustConnected] = useState(false);
  const [telegramJustConnected, setTelegramJustConnected] = useState(false);
  const whatsAppQRCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      clearWhatsAppQRListener(whatsAppQRCleanupRef);
    };
  }, []);

  const handleWhatsAppConnect = useCallback(async (): Promise<void> => {
    setChatSyncLoading('whatsapp');
    try {
      await connectWhatsApp({
        fetchIntegrations,
        qrCleanupRef: whatsAppQRCleanupRef,
        setQRCode: setWhatsAppQRCode,
        setQRModalOpen: setWhatsAppQRModalOpen,
        setJustConnected: setWhatsAppJustConnected,
      });
    } catch (err) {
      console.error('Failed to connect WhatsApp:', err);
      throw err;
    } finally {
      setChatSyncLoading(null);
    }
  }, [fetchIntegrations]);

  const handleTelegramConnect = useCallback(async (): Promise<void> => {
    setChatSyncLoading('telegram');
    try {
      await connectTelegram({
        fetchIntegrations,
        setAuthModalOpen: setTelegramAuthModalOpen,
        setJustConnected: setTelegramJustConnected,
      });
    } catch (err) {
      console.error('Failed to connect Telegram:', err);
      throw err;
    } finally {
      setChatSyncLoading(null);
    }
  }, [fetchIntegrations]);

  const closeWhatsAppQRModal = useCallback((): void => {
    clearWhatsAppQRListener(whatsAppQRCleanupRef);
    setWhatsAppQRModalOpen(false);
    setWhatsAppQRCode(null);
  }, []);

  const closeTelegramAuthModal = useCallback((): void => {
    setTelegramAuthModalOpen(false);
  }, []);

  const onTelegramAuthSuccess = useCallback((): void => {
    setTelegramJustConnected(true);
    setTelegramAuthModalOpen(false);
    void fetchIntegrations();
  }, [fetchIntegrations]);

  return {
    chatSyncLoading,
    whatsAppQRModalOpen,
    whatsAppQRCode,
    telegramAuthModalOpen,
    whatsAppJustConnected,
    telegramJustConnected,
    handleWhatsAppConnect,
    handleTelegramConnect,
    closeWhatsAppQRModal,
    closeTelegramAuthModal,
    onTelegramAuthSuccess,
  };
}
