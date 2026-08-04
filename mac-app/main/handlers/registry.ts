import { SyncManager } from '../services/sync/SyncManager';
import { logConsoleError } from '../base/logger';
import { registerAuthHandlers, registerPasskeyHandlers } from './auth';
import {
  registerBrowserSyncHandlers,
  registerCookieHandlers,
  registerFingerprintHandlers,
} from './browser';
import { registerAtlasHandlers, registerComputeCredentialHandlers } from './credentials';
import { registerIMessageHandlers } from './imessage';
import { registerOnboardingHandlers, registerShortcutHandlers } from './preferences';
import { registerShellHandlers, registerSystemHandlers } from './system';
import {
  registerTelegramAuthHandlers,
  registerTelegramConnectionHandlers,
  registerTelegramStatusHandlers,
} from './telegram';
import { registerWhatsAppHandlers } from './whatsapp';

export { getOnboardingComplete, getShortcutConfig } from './state';

export function registerHandlers(): void {
  registerAuthHandlers();
  registerPasskeyHandlers();
  registerIMessageHandlers();
  registerCookieHandlers();
  registerBrowserSyncHandlers();
  registerFingerprintHandlers();
  registerSystemHandlers();
  registerShellHandlers();
  registerShortcutHandlers();
  registerOnboardingHandlers();
  registerAtlasHandlers();
  registerComputeCredentialHandlers();
  registerWhatsAppHandlers();
  registerTelegramStatusHandlers();
  registerTelegramConnectionHandlers();
  registerTelegramAuthHandlers();
}

registerHandlers();

void SyncManager.startAll().catch((error) =>
  logConsoleError('Startup', 'SyncManager startup error', error)
);
