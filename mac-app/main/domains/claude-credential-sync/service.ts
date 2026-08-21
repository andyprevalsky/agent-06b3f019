/**
 * Service layer for claude-credential-sync.
 *
 * Orchestrates the full sync flow:
 *   1. Verify auth session exists
 *   2. Read credentials from the macOS Keychain
 *   3. If missing: install Claude Code CLI + run OAuth → re-read
 *   4. Validate credential shape (must contain claudeAiOauth.accessToken)
 *   5. Hybrid-encrypt with RSA+AES, wrap with Crypto envelope, POST to backend
 *   6. Invalidate the integration cache on success
 *
 * All side effects go through repo.ts, the Crypto provider, and fetch.
 */

import crypto from 'crypto';
import { Crypto } from '../../base/crypto';
import { config } from '../../base/config';
import { getErrorMessage } from '../../../shared/utils/error';
import { logConsole, logConsoleError } from '../../base/logger';
import { AuthService } from '../../services/auth';
import {
  IMPERSONATED_MACHINE_DATA_MESSAGE,
  sessionForLocalMachineData,
} from '../../base/impersonation';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { RSA_PUBLIC_KEY_PEM } from './config';
import {
  findNpmClaudePath,
  installClaudeCLI,
  keychainHasCredentials,
  readKeychainCredentials,
  runClaudeSetupToken,
} from './repo';
import type {
  ClaudeCredentialsJson,
  HybridEncryptionEnvelope,
  SyncResult,
  SyncStatusCallback,
} from './types';

const LOG_COMPONENT = 'ClaudeCredentialSync';
let lastUploadedCredentialsHash: string | null = null;

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Whether Claude Code credentials exist in the macOS Keychain. */
export function hasCredentials(): boolean {
  return keychainHasCredentials();
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

/**
 * Encrypt a JSON credential string using RSA-2048 + AES-256-GCM hybrid
 * encryption. Mirrors `BrowserPasswordReader.encryptPassword()` but uses the
 * Claude-credential public key.
 */
function encryptWithRsaHybrid(data: string): string {
  // 1. Generate random AES-256 key and IV.
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  // 2. Encrypt data with AES-256-GCM.
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  // 3. Encrypt AES key with RSA-OAEP.
  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  // 4. Build envelope.
  const envelope: HybridEncryptionEnvelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/** Encrypt and upload a credentials JSON string to the backend. */
async function uploadCredentials(credentialsJson: string, accessToken: string): Promise<void> {
  const encryptedEnvelope = encryptWithRsaHybrid(credentialsJson);
  const { encrypted, iv, key } = Crypto.encrypt({ encryptedCredentials: encryptedEnvelope });

  const response = await fetch(`${config.apiUrl}/api/integrations/claude-code/credentials/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: encrypted, iv, key }),
  });

  if (!response.ok) {
    const errorData = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorData?.error ?? `Upload failed: ${response.status}`);
  }
}

function credentialHash(credentialsJson: string): string {
  return crypto.createHash('sha256').update(credentialsJson).digest('hex');
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/** Parse credentials JSON and confirm it has the required OAuth access token. */
function validateCredentials(credentialsJson: string): SyncResult | null {
  let parsed: ClaudeCredentialsJson;
  try {
    parsed = JSON.parse(credentialsJson) as ClaudeCredentialsJson;
  } catch {
    return { success: false, message: 'Claude Code credentials are not valid JSON' };
  }
  if (parsed.claudeAiOauth?.accessToken === undefined || parsed.claudeAiOauth.accessToken === '') {
    return {
      success: false,
      message:
        'Claude Code credentials missing OAuth access token. Please re-login to Claude Code.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Install + OAuth flow
// ---------------------------------------------------------------------------

class SyncFailure extends Error {
  constructor(public readonly result: SyncResult) {
    super(result.message ?? 'sync failed');
  }
}

const log = (line: string): void => logConsole(LOG_COMPONENT, line);

/**
 * Drive the install + OAuth flow when no credentials exist in the Keychain.
 * Returns the newly-stored credentials JSON, or throws `SyncFailure` with the
 * user-visible failure result.
 *
 * The re-read after OAuth deliberately goes through `readKeychainCredentials`
 * directly so it bypasses `mockNoClaudeCode` — the OAuth flow has just written
 * real credentials to the Keychain, and the mock would otherwise hide them.
 */
async function ensureCredentialsAfterOAuth(
  sendStatus: SyncStatusCallback,
  mockNoClaudeCode: boolean
): Promise<string> {
  const claudePath = findNpmClaudePath();
  const installed = !mockNoClaudeCode && claudePath !== null;
  logConsole(
    LOG_COMPONENT,
    `Claude Code installed (npm): ${installed}, path: ${claudePath ?? 'none'}`
  );

  if (!installed) {
    await installClaudeCLI({ onStatus: sendStatus, onLog: log });
    const installedAfter = !mockNoClaudeCode && findNpmClaudePath() !== null;
    if (!installedAfter) {
      sendStatus('');
      throw new SyncFailure({
        success: false,
        message:
          'Claude Code installation failed. Please install manually: npm install -g @anthropic-ai/claude-code',
      });
    }
    sendStatus('Claude Code installed');
  }

  await runClaudeSetupToken({ forceLogout: mockNoClaudeCode, onStatus: sendStatus, onLog: log });

  sendStatus('Reading credentials...');
  const credentials = readKeychainCredentials();
  if (credentials === null) {
    sendStatus('');
    throw new SyncFailure({
      success: false,
      message: 'Authentication completed but credentials not found in Keychain. Please try again.',
    });
  }
  return credentials;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface SyncCredentialsOptions {
  sendStatus: SyncStatusCallback;
  mockNoClaudeCode: boolean;
}

/**
 * Read, encrypt, and upload Claude Code credentials.
 * If no credentials are found in the Keychain, install Claude Code and run
 * the OAuth flow first.
 */
export async function syncCredentials(opts: SyncCredentialsOptions): Promise<SyncResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  const { sendStatus, mockNoClaudeCode } = opts;

  // 1. Initial keychain read. Mock mode forces the OAuth path.
  let credentialsJson = mockNoClaudeCode ? null : readKeychainCredentials();
  logConsole(LOG_COMPONENT, `Keychain credentials found: ${credentialsJson !== null}`);

  // 2. Missing credentials: install + OAuth.
  if (credentialsJson === null) {
    try {
      credentialsJson = await ensureCredentialsAfterOAuth(sendStatus, mockNoClaudeCode);
    } catch (error) {
      if (error instanceof SyncFailure) return error.result;
      const message = getErrorMessage(error);
      logConsoleError(LOG_COMPONENT, 'Install/auth flow failed', error);
      sendStatus('');
      return { success: false, message };
    }
  }

  // 3. Validate credential structure.
  const validation = validateCredentials(credentialsJson);
  if (validation !== null) return validation;

  // 4. Encrypt and upload.
  try {
    sendStatus('Uploading credentials...');
    await uploadCredentials(credentialsJson, session.access_token);
    lastUploadedCredentialsHash = credentialHash(credentialsJson);
    IntegrationCache.invalidate();
    sendStatus('');
    logConsole(LOG_COMPONENT, 'Credentials synced successfully');
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    logConsoleError(LOG_COMPONENT, 'Upload failed', error);
    sendStatus('');
    return { success: false, message };
  }
}

/**
 * Cheap periodic refresh path: read existing local credentials and upload only
 * when the credential JSON changed. This never installs Claude Code or opens
 * the OAuth browser flow.
 */
export async function syncExistingCredentialsIfChanged(): Promise<SyncResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  const credentialsJson = readKeychainCredentials();
  if (credentialsJson === null) {
    return { success: false, message: 'Claude Code credentials not found in Keychain' };
  }

  const validation = validateCredentials(credentialsJson);
  if (validation !== null) return validation;

  const nextHash = credentialHash(credentialsJson);
  if (nextHash === lastUploadedCredentialsHash) {
    return { success: true, message: 'unchanged' };
  }

  try {
    await uploadCredentials(credentialsJson, session.access_token);
    lastUploadedCredentialsHash = nextHash;
    IntegrationCache.invalidate();
    logConsole(LOG_COMPONENT, 'Periodic credentials sync uploaded changed credentials');
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    logConsoleError(LOG_COMPONENT, 'Periodic upload failed', error);
    return { success: false, message };
  }
}
