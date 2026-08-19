/**
 * Service layer for gpt-credential-sync.
 *
 * Orchestrates the full sync flow:
 *   1. Verify auth session exists
 *   2. Read the ChatGPT auth envelope from ~/.codex/auth.json
 *   3. If missing / not ChatGPT mode: install the Codex CLI + run `codex login`
 *      → re-read
 *   4. Validate the token fields the backend needs
 *   5. Hybrid-encrypt with RSA+AES, wrap with Crypto envelope, POST to backend
 *   6. Invalidate the integration cache on success
 *
 * Step 3 is what makes "Connect ChatGPT" self-sufficient. Without it the button
 * can only ever report the state of a file the user has to go create by hand in
 * Terminal, which is a dead end when the CLI isn't installed or is broken.
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
import { CODEX_NPM_PACKAGE, GPT_CREDENTIAL_UPLOAD_PATH, RSA_PUBLIC_KEY_PEM } from './config';
import {
  backupCodexAuthFile,
  codexCliIsUsable,
  hasCodexAuthFile,
  installCodexCLI,
  readCodexAuthFile,
  runCodexLogin,
} from './repo';
import type {
  CodexAuthJson,
  HybridEncryptionEnvelope,
  SyncResult,
  SyncStatusCallback,
} from './types';

const LOG_COMPONENT = 'GptCredentialSync';
let lastUploadedCredentialsHash: string | null = null;

export function hasCredentials(): boolean {
  return hasCodexAuthFile();
}

function encryptWithRsaHybrid(data: string): string {
  const aesKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  const envelope: HybridEncryptionEnvelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

function validateCredentials(credentialsJson: string): SyncResult | null {
  let parsed: CodexAuthJson;
  try {
    parsed = JSON.parse(credentialsJson) as CodexAuthJson;
  } catch {
    return { success: false, message: 'Codex credentials are not valid JSON' };
  }

  if (parsed.auth_mode !== 'chatgpt') {
    return { success: false, message: 'Codex is not logged in with a ChatGPT account' };
  }

  if (
    parsed.tokens?.access_token === undefined ||
    parsed.tokens.refresh_token === undefined ||
    parsed.tokens.access_token.length === 0 ||
    parsed.tokens.refresh_token.length === 0
  ) {
    return {
      success: false,
      message: 'Codex credentials missing access or refresh token. Please run codex login.',
    };
  }

  return null;
}

async function uploadCredentials(credentialsJson: string, accessToken: string): Promise<void> {
  const encryptedEnvelope = encryptWithRsaHybrid(credentialsJson);
  const { encrypted, iv, key } = Crypto.encrypt({ encryptedCredentials: encryptedEnvelope });

  const response = await fetch(`${config.apiUrl}${GPT_CREDENTIAL_UPLOAD_PATH}`, {
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

async function backendGptIntegrationIsConnected(): Promise<boolean> {
  const integration = await IntegrationCache.getIntegration('gpt_code');
  return integration?.status === 'CONNECTED' && integration.isActive !== false;
}

// ---------------------------------------------------------------------------
// Install + ChatGPT login flow
// ---------------------------------------------------------------------------

class SyncFailure extends Error {
  constructor(public readonly result: SyncResult) {
    super(result.message ?? 'sync failed');
  }
}

const log = (line: string): void => logConsole(LOG_COMPONENT, line);

/**
 * Drive the install + `codex login` flow, then return the resulting auth JSON.
 * Throws `SyncFailure` carrying the user-visible failure result.
 */
async function ensureCredentialsAfterLogin(sendStatus: SyncStatusCallback): Promise<string> {
  if (!codexCliIsUsable()) {
    // Covers both "never installed" and "installed but the vendored binary is
    // missing", which present identically to the user: the CLI cannot run.
    logConsole(LOG_COMPONENT, 'Codex CLI missing or not runnable; installing');
    await installCodexCLI({ onStatus: sendStatus, onLog: log });
    if (!codexCliIsUsable()) {
      sendStatus('');
      throw new SyncFailure({
        success: false,
        message: `Codex installation failed. Please install manually: npm install -g ${CODEX_NPM_PACKAGE}`,
      });
    }
    sendStatus('Codex installed');
  }

  // `codex login` overwrites auth.json, so preserve any existing (e.g. API-key)
  // login the user may want to go back to.
  const backupPath = backupCodexAuthFile();
  if (backupPath !== null) {
    logConsole(LOG_COMPONENT, `Backed up existing Codex auth file to ${backupPath}`);
  }

  await runCodexLogin({ onStatus: sendStatus, onLog: log });

  sendStatus('Reading credentials...');
  const credentials = readCodexAuthFile();
  if (credentials === null) {
    sendStatus('');
    throw new SyncFailure({
      success: false,
      message: 'ChatGPT sign-in completed but no Codex credentials were written. Please try again.',
    });
  }
  return credentials;
}

export interface SyncCredentialsOptions {
  sendStatus: SyncStatusCallback;
}

export async function syncCredentials(opts: SyncCredentialsOptions): Promise<SyncResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  const { sendStatus } = opts;

  let credentialsJson = readCodexAuthFile();
  logConsole(LOG_COMPONENT, `Codex auth file found: ${credentialsJson !== null}`);

  // Missing or non-ChatGPT credentials: install the CLI and run the login the
  // user just asked for, rather than telling them to go do it in Terminal.
  if (credentialsJson === null || validateCredentials(credentialsJson) !== null) {
    try {
      credentialsJson = await ensureCredentialsAfterLogin(sendStatus);
    } catch (error) {
      if (error instanceof SyncFailure) return error.result;
      const message = getErrorMessage(error);
      logConsoleError(LOG_COMPONENT, 'Install/login flow failed', error);
      sendStatus('');
      return { success: false, message };
    }
  }

  const validation = validateCredentials(credentialsJson);
  if (validation !== null) {
    sendStatus('');
    return validation;
  }

  try {
    sendStatus('Uploading credentials...');
    await uploadCredentials(credentialsJson, session.access_token);
    sendStatus('');
    lastUploadedCredentialsHash = credentialHash(credentialsJson);
    IntegrationCache.invalidate();
    logConsole(LOG_COMPONENT, 'Credentials synced successfully');
    return { success: true };
  } catch (error) {
    const message = getErrorMessage(error);
    logConsoleError(LOG_COMPONENT, 'Upload failed', error);
    return { success: false, message };
  }
}

export async function syncExistingCredentialsIfChanged(): Promise<SyncResult> {
  const currentSession = await AuthService.getSession();
  const session = sessionForLocalMachineData(currentSession);
  if (!session) {
    return {
      success: false,
      message: currentSession === null ? 'Not authenticated' : IMPERSONATED_MACHINE_DATA_MESSAGE,
    };
  }

  const credentialsJson = readCodexAuthFile();
  if (credentialsJson === null) {
    return {
      success: false,
      message: 'Codex credentials not found. Please run codex login in Terminal.',
    };
  }

  const validation = validateCredentials(credentialsJson);
  if (validation !== null) return validation;

  const nextHash = credentialHash(credentialsJson);
  const backendConnected = await backendGptIntegrationIsConnected();
  if (nextHash === lastUploadedCredentialsHash && backendConnected) {
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
