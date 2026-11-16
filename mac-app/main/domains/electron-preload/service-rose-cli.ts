/**
 * `window.api.roseCli` bridge (the `rose` CLI the Mac app provides).
 *
 * Split out of `service.ts` to keep each file under the 300-line strict
 * budget. Pure — no `contextBridge` side effects. Channel names are the wire
 * contract with main/domains/rose-cli/runtime.ts.
 */

import type { IpcRenderer, IpcRendererEvent } from 'electron';
import type {
  IPC,
  RoseCliFolderPickResult,
  RoseCliImportEvent,
  RoseCliImportRequest,
  RoseCliImportStartResult,
  RoseCliInstallResult,
} from '../../../shared/types/ipc';

export function buildRoseCliBridge(ipcRenderer: IpcRenderer): IPC['roseCli'] {
  return {
    ensureInstalled: () =>
      ipcRenderer.invoke('roseCli:ensureInstalled') as Promise<RoseCliInstallResult>,
    pickProjectFolder: () =>
      ipcRenderer.invoke('roseCli:pickProjectFolder') as Promise<RoseCliFolderPickResult>,
    importProject: (request: RoseCliImportRequest) =>
      ipcRenderer.invoke('roseCli:importProject', request) as Promise<RoseCliImportStartResult>,
    onImportEvent: (listener: (event: RoseCliImportEvent) => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void =>
        listener(payload as RoseCliImportEvent);
      ipcRenderer.on('roseCli:importEvent', handler);
      return () => {
        ipcRenderer.removeListener('roseCli:importEvent', handler);
      };
    },
    cancelImport: (runId: string) =>
      ipcRenderer.invoke('roseCli:cancelImport', runId) as Promise<void>,
  };
}
