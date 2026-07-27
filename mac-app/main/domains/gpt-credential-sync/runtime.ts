/**
 * Runtime layer for gpt-credential-sync.
 *
 * Wraps a BrowserWindow into a status callback so the install/login flow can
 * stream progress to the renderer, and delegates all logic to ./service.
 */

import type { BrowserWindow } from 'electron';
import { logConsole } from '../../base/logger';
import * as service from './service';
import type { SyncResult, SyncStatusCallback } from './types';

const LOG_COMPONENT = 'GptCredentialSync';

function buildSendStatus(window?: BrowserWindow | null): SyncStatusCallback {
  return (status: string) => {
    logConsole(LOG_COMPONENT, `Status: ${status}`);
    // A destroyed BrowserWindow is not null, and sending to it throws
    // "Object has been destroyed" — which would abort a login that is otherwise
    // succeeding. Progress reporting must never fail the flow it reports on.
    if (window === undefined || window === null || window.isDestroyed()) return;
    try {
      window.webContents.send('gpt:setupStatus', status);
    } catch {
      // The window went away between the check and the send; status is advisory.
    }
  };
}

export class GptCredentialSync {
  static hasCredentials(): boolean {
    return service.hasCredentials();
  }

  /** Read (or obtain via `codex login`), encrypt, and upload Codex credentials. */
  static async syncCredentials(window?: BrowserWindow | null): Promise<SyncResult> {
    return service.syncCredentials({ sendStatus: buildSendStatus(window) });
  }

  /** Non-interactive periodic refresh; never triggers a login. */
  static async syncExistingCredentialsIfChanged(): Promise<SyncResult> {
    return service.syncExistingCredentialsIfChanged();
  }
}
