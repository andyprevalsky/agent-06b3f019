/**
 * STATE MACHINE: useWhatsAppConnect
 *
 *   [IDLE] --connect()--> [RESUMING]            (stored credentials present)
 *        RESUMING --success--> [IDLE] (connected)
 *        RESUMING --failure--> [PAIRING]
 *   [IDLE] --connect(), no credentials--> [PAIRING]
 *        PAIRING --QR streamed over IPC--> [PAIRING + qrCode]
 *        PAIRING --paired--> [IDLE] (modal closed)
 *        PAIRING --error/close--> [IDLE] (modal closed, error returned)
 *
 * System context:
 *   Shared Integrations WhatsApp row -> IntegrationHandlers.whatsApp.connect()
 *     -> this hook -> window.api.whatsapp IPC -> native WhatsApp bridge
 *     -> QR pushed back over onWhatsAppQRCode -> WhatsAppQRModal (rendered by ui/main.tsx)
 *
 * The desktop shell owns the whole pairing UX so the shared front-end -- which
 * also runs on the web, where no QR pairing exists -- needs no QR dependency.
 * Resolves rather than throws: the shared caller reports the error inline.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getErrorMessageOrFallback } from '../../shared/utils/error';
import { getElectronApi } from './electron-api';

export interface WhatsAppConnectState {
  isAvailable: boolean;
  isModalOpen: boolean;
  isConnecting: boolean;
  qrCode: string | null;
  connect: () => Promise<{ success: boolean; error?: string }>;
  closeModal: () => void;
}

const UNAVAILABLE = 'WhatsApp is unavailable in this app version.';
const FAILED = 'WhatsApp connection failed. Please try again.';
const CANCELED = 'WhatsApp pairing was canceled.';

export function useWhatsAppConnect(): WhatsAppConnectState {
  const [isModalOpen, setModalOpen] = useState(false);
  const [isConnecting, setConnecting] = useState(false);
  const [qrCode, setQRCode] = useState<string | null>(null);
  const qrCleanupRef = useRef<(() => void) | null>(null);
  /** Settles the in-flight `connect()` when the user dismisses the QR modal. */
  const dismissRef = useRef<(() => void) | null>(null);

  const clearQRListener = useCallback(() => {
    qrCleanupRef.current?.();
    qrCleanupRef.current = null;
  }, []);

  // A pairing left open when the window unmounts would otherwise leak the IPC
  // subscription (and strand the caller) for the lifetime of the app.
  useEffect(
    () => () => {
      dismissRef.current?.();
      dismissRef.current = null;
      clearQRListener();
    },
    [clearQRListener]
  );

  const connect = useCallback(async () => {
    const whatsapp = getElectronApi()?.whatsapp;
    if (whatsapp === undefined) return { success: false, error: UNAVAILABLE };

    clearQRListener();
    setConnecting(true);
    try {
      // A previously linked device can resume without showing a QR at all.
      if (await whatsapp.hasCredentials()) {
        const resumed = await whatsapp.connect();
        if (resumed.success) return { success: true };
      }

      const onQRCode = getElectronApi()?.onWhatsAppQRCode;
      if (onQRCode !== undefined) {
        qrCleanupRef.current = onQRCode((qr: string) => setQRCode(qr));
      }
      setModalOpen(true);

      // Native pairing only settles when the phone scans the QR, so a user who
      // dismisses the modal would otherwise leave the caller (and the shared
      // Integrations row's spinner) pending indefinitely. Race the native call
      // against dismissal so closing the modal always settles this attempt.
      const dismissal = new Promise<{ success: false; error: string }>((resolve) => {
        dismissRef.current = () => resolve({ success: false, error: CANCELED });
      });
      const result = await Promise.race([whatsapp.connect(), dismissal]);
      return result.success ? { success: true } : { success: false, error: result.error ?? FAILED };
    } catch (error) {
      return { success: false, error: getErrorMessageOrFallback(error, FAILED) };
    } finally {
      // A late result from an abandoned attempt must not reopen or re-clear UI
      // that a newer attempt now owns.
      dismissRef.current = null;
      clearQRListener();
      setConnecting(false);
      setModalOpen(false);
      setQRCode(null);
    }
  }, [clearQRListener]);

  const closeModal = useCallback(() => {
    // Settle the in-flight attempt first; the finally block above owns the rest
    // of the teardown so both paths converge on the same cleared state.
    dismissRef.current?.();
    dismissRef.current = null;
    clearQRListener();
    setModalOpen(false);
    setQRCode(null);
  }, [clearQRListener]);

  return {
    isAvailable: getElectronApi()?.whatsapp !== undefined,
    isModalOpen,
    isConnecting,
    qrCode,
    connect,
    closeModal,
  };
}
