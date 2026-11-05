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
  QuickQueryHeldSubmit,
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

/**
 * Launcher submits wait in the main process until the consumer claims them,
 * because the main window may have been (re)opened to receive one. List what
 * is held on subscribe and again whenever the main process says one is
 * waiting, and hand each submit over with the claim that removes it there.
 */
function buildQuickQuerySubmitSubscription(
  ipcRenderer: IpcRenderer
): (callback: (payload: QuickQueryPayload, claim: () => Promise<boolean>) => void) => () => void {
  // A held submit is listed until it is claimed; forward each one once.
  const forwarded = new Set<string>();

  const claimOf = (id: string) => (): Promise<boolean> =>
    (ipcRenderer.invoke('quick-query:claim', id) as Promise<{ claimed: boolean }>).then(
      (result) => result.claimed,
      (error: unknown) => {
        // Still held by the main process: let the next listing offer it again.
        forwarded.delete(id);
        console.error('[QuickQuery] Failed to claim a pending submit', error);
        return false;
      }
    );

  return (callback) => {
    const take = (): void => {
      (ipcRenderer.invoke('quick-query:take') as Promise<QuickQueryHeldSubmit[]>)
        .then((held) => {
          for (const { id, payload } of held) {
            if (forwarded.has(id)) continue;
            forwarded.add(id);
            callback(payload, claimOf(id));
          }
        })
        .catch((error: unknown) => {
          console.error('[QuickQuery] Failed to take pending submits', error);
        });
    };
    ipcRenderer.on('quick-query:pending', take);
    take();
    return () => {
      ipcRenderer.removeListener('quick-query:pending', take);
    };
  };
}

export function buildUnsubscribableEventBridge(
  ipcRenderer: IpcRenderer
): Pick<
  IPC,
  | 'onOpenAgent'
  | 'onQuickQuerySubmit'
  | 'onClaudeSetupStatus'
  | 'onGptSetupStatus'
  | 'onWhatsAppQRCode'
  | 'onPasskeysImportComplete'
  | 'onOAuthComplete'
> {
  let pendingOpenAgentId: string | null = null;
  const openAgentCallbacks = new Set<(agentId: string) => void>();
  ipcRenderer.on('open-agent', (_event, agentId: unknown) => {
    const value = agentId as string;
    if (openAgentCallbacks.size === 0) {
      pendingOpenAgentId = value;
      return;
    }
    for (const callback of openAgentCallbacks) callback(value);
  });

  return {
    onOpenAgent: (callback: (agentId: string) => void) => {
      openAgentCallbacks.add(callback);
      if (pendingOpenAgentId !== null) {
        const value = pendingOpenAgentId;
        pendingOpenAgentId = null;
        callback(value);
      }
      return () => {
        openAgentCallbacks.delete(callback);
      };
    },
    onQuickQuerySubmit: buildQuickQuerySubmitSubscription(ipcRenderer),
    onClaudeSetupStatus: (callback: (status: string) => void) => {
      const handler = (_event: IpcRendererEvent, status: unknown) => callback(status as string);
      ipcRenderer.on('claude:setupStatus', handler);
      return () => {
        ipcRenderer.removeListener('claude:setupStatus', handler);
      };
    },
    onGptSetupStatus: (callback: (status: string) => void) => {
      const handler = (_event: IpcRendererEvent, status: unknown) => callback(status as string);
      ipcRenderer.on('gpt:setupStatus', handler);
      return () => {
        ipcRenderer.removeListener('gpt:setupStatus', handler);
      };
    },
    onWhatsAppQRCode: (callback: (qr: string) => void) => {
      const handler = (_event: IpcRendererEvent, qr: unknown) => callback(qr as string);
      ipcRenderer.on('whatsapp:qrCode', handler);
      return () => {
        ipcRenderer.removeListener('whatsapp:qrCode', handler);
      };
    },
    onOAuthComplete: (callback: (data: { success: boolean }) => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) =>
        callback(data as { success: boolean });
      ipcRenderer.on('oauth-complete', handler);
      return () => {
        ipcRenderer.removeListener('oauth-complete', handler);
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
