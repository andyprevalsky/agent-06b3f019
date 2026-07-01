/**
 * Subscription-channel builders for the electron-preload domain.
 *
 * Split out of `service.ts` to keep each file under the 300-line strict
 * budget. All builders are pure — no `contextBridge` side effects.
 *
 * Event categories:
 *   - `buildEventBridge`          — fire-and-forget `ipcRenderer.on` listeners
 *   - `buildUnsubscribableEventBridge` — listeners that return a disposer
 *   - `buildTelegramEventBridge`  — Telegram auth lifecycle events
 */

import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  IPC,
  UploadProgress,
  QuickQueryToggleState,
  QuickQueryPayload,
  UpdateStatusPayload,
  PasskeyImportResult,
} from '../../../shared/types/ipc';

export function buildEventBridge(
  ipcRenderer: IpcRenderer
): Pick<
  IPC,
  | 'onProgress'
  | 'onQuickQueryToggle'
  | 'onQuickQuerySubmit'
  | 'onUpdateStatus'
  | 'onUpdateProgress'
  | 'onFocusInput'
  | 'onPaymentComplete'
> {
  return {
    onProgress: (callback: (progress: UploadProgress) => void) => {
      ipcRenderer.on('upload:progress', (_, data) => callback(data as UploadProgress));
    },
    onQuickQueryToggle: (callback: (state: QuickQueryToggleState) => void) => {
      ipcRenderer.on('quick-query:toggle', (_, state) => callback(state as QuickQueryToggleState));
    },
    onQuickQuerySubmit: (callback: (payload: QuickQueryPayload) => void) => {
      ipcRenderer.on('quick-query:submit', (_, payload) => callback(payload as QuickQueryPayload));
    },
    onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => {
      ipcRenderer.on('update:status', (_, payload) => callback(payload as UpdateStatusPayload));
    },
    onUpdateProgress: (callback: (percent: number) => void) => {
      ipcRenderer.on('update:progress', (_, data) =>
        callback((data as { percent: number }).percent)
      );
    },
    onFocusInput: (callback: () => void) => {
      ipcRenderer.on('focus-input', () => callback());
    },
    onPaymentComplete: (callback: (data: { success: boolean }) => void) => {
      ipcRenderer.on('payment-complete', (_, data) => callback(data as { success: boolean }));
    },
  };
}

export function buildUnsubscribableEventBridge(
  ipcRenderer: IpcRenderer
): Pick<IPC, 'onClaudeSetupStatus' | 'onWhatsAppQRCode' | 'onPasskeysImportComplete'> {
  return {
    onClaudeSetupStatus: (callback: (status: string) => void) => {
      const handler = (_event: IpcRendererEvent, status: unknown) => callback(status as string);
      ipcRenderer.on('claude:setupStatus', handler);
      return () => {
        ipcRenderer.removeListener('claude:setupStatus', handler);
      };
    },
    onWhatsAppQRCode: (callback: (qr: string) => void) => {
      const handler = (_event: IpcRendererEvent, qr: unknown) => callback(qr as string);
      ipcRenderer.on('whatsapp:qrCode', handler);
      return () => {
        ipcRenderer.removeListener('whatsapp:qrCode', handler);
      };
    },
    onPasskeysImportComplete: (callback: (result: PasskeyImportResult) => void) => {
      const handler = (_event: IpcRendererEvent, result: unknown) =>
        callback(result as PasskeyImportResult);
      ipcRenderer.on('passkeys:importComplete', handler);
      return () => {
        ipcRenderer.removeListener('passkeys:importComplete', handler);
      };
    },
  };
}

export function buildTelegramEventBridge(
  ipcRenderer: IpcRenderer
): Pick<
  IPC,
  'onTelegramNeedCode' | 'onTelegramNeedPassword' | 'onTelegramAuthComplete' | 'onTelegramAuthError'
> {
  return {
    onTelegramNeedCode: (callback: () => void) => {
      ipcRenderer.on('telegram:needCode', () => callback());
    },
    onTelegramNeedPassword: (callback: () => void) => {
      ipcRenderer.on('telegram:needPassword', () => callback());
    },
    onTelegramAuthComplete: (callback: () => void) => {
      ipcRenderer.on('telegram:authComplete', () => callback());
    },
    onTelegramAuthError: (callback: (error: string) => void) => {
      ipcRenderer.on('telegram:authError', (_, error) => callback(error as string));
    },
  };
}
