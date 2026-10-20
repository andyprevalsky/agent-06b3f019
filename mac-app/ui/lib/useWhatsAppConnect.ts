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
 *   [IDLE] --addAccount()--> [PAIRING]          (always pairs one more phone, plan row I2)
 *   [IDLE] --logout(accountId)--> [IDLE]        (that phone only; no modal)
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
  /** Pair one more phone (multi-account); always shows the QR modal. */
  addAccount: () => Promise<{ success: boolean; error?: string }>;
  /** Log one linked phone out on this Mac. */
  logout: (accountId: string) => Promise<{ success: boolean; error?: string }>;
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

  /**
   * Run one native pairing call behind the QR modal. `resumeFirst` lets
   * `connect()` reuse stored credentials before showing a QR.
   */
  const pair = useCallback(
    async (
      start: () => Promise<{ success: boolean; error?: string }>,
      resumeFirst?: () => Promise<boolean>
    ) => {
      clearQRListener();
      setConnecting(true);
      try {
        // A previously linked device can resume without showing a QR at all.
        if (resumeFirst !== undefined && (await resumeFirst())) return { success: true };

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
        const result = await Promise.race([start(), dismissal]);
        return result.success
          ? { success: true }
          : { success: false, error: result.error ?? FAILED };
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
    },
    [clearQRListener]
  );

  const connect = useCallback(async () => {
    const whatsapp = getElectronApi()?.whatsapp;
    if (whatsapp === undefined) return { success: false, error: UNAVAILABLE };
    return pair(
      () => whatsapp.connect(),
      async () => (await whatsapp.hasCredentials()) && (await whatsapp.connect()).success
    );
  }, [pair]);

  const addAccount = useCallback(async () => {
    const add = getElectronApi()?.whatsapp?.addAccount;
    if (add === undefined) return { success: false, error: UNAVAILABLE };
    return pair(() => add());
  }, [pair]);

  const logout = useCallback(async (accountId: string) => {
    const whatsapp = getElectronApi()?.whatsapp;
    if (whatsapp === undefined) return { success: false, error: UNAVAILABLE };
    try {
      const result = await whatsapp.logout(accountId);
      return result.success ? { success: true } : { success: false, error: result.error ?? FAILED };
    } catch (error) {
      return { success: false, error: getErrorMessageOrFallback(error, FAILED) };
    }
  }, []);

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
    addAccount,
    logout,
    closeModal,
  };
}
