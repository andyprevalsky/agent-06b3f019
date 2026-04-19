/**
 * Runtime layer for claude-credential-sync.
 *
 * Exposes the static `ClaudeCredentialSync` class that the IPC handlers and
 * tests invoke. Keeps the public surface area identical to the pre-refactor
 * flat file so wiring and mocks don't need to change.
 *
 * Responsibilities:
 *   - Hold the `mockNoClaudeCode` test flag
 *   - Wrap a BrowserWindow into a status callback for IPC progress events
 *   - Delegate all business logic to ./service
 */

import type { BrowserWindow } from 'electron';
import { logConsole } from '../../base/logger';
import * as service from './service';
import type { SyncResult, SyncStatusCallback } from './types';

const LOG_COMPONENT = 'ClaudeCredentialSync';

// Module-level test flag: true forces the OAuth flow even when the Keychain
// contains credentials. Keeps parity with the pre-refactor static field so
// existing tests (`ClaudeCredentialSync.setMockNoClaudeCode(true)`) still work.
let mockNoClaudeCode = false;

function buildSendStatus(window?: BrowserWindow | null): SyncStatusCallback {
  return (status: string) => {
    logConsole(LOG_COMPONENT, `Status: ${status}`);
    window?.webContents.send('claude:setupStatus', status);
  };
}

export class ClaudeCredentialSync {
  static setMockNoClaudeCode(mock: boolean): void {
    mockNoClaudeCode = mock;
    logConsole(LOG_COMPONENT, `Mock no Claude Code: ${mock}`);
  }

  /** Whether Claude Code credentials exist in the macOS Keychain. */
  static hasCredentials(): boolean {
    return service.hasCredentials();
  }

  /** Read, encrypt, and upload Claude Code credentials. */
  static async syncCredentials(window?: BrowserWindow | null): Promise<SyncResult> {
    return service.syncCredentials({
      sendStatus: buildSendStatus(window),
      mockNoClaudeCode,
    });
  }
}
