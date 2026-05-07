/**
 * Service layer for gpt-credential-sync.
 *
 * Reads Codex's local ChatGPT auth envelope from ~/.codex/auth.json, validates
 * the token fields the backend needs, hybrid-encrypts the JSON, uploads it,
 * and invalidates the integration cache on success.
 */

import crypto from 'crypto';
import { Crypto } from '../../base/crypto';
import { config } from '../../base/config';
import { logConsole, logConsoleError } from '../../base/logger';
import { AuthService } from '../../services/auth';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { GPT_CREDENTIAL_UPLOAD_PATH, RSA_PUBLIC_KEY_PEM } from './config';
import { hasCodexAuthFile, readCodexAuthFile } from './repo';
import type { CodexAuthJson, HybridEncryptionEnvelope, SyncResult } from './types';

const LOG_COMPONENT = 'GptCredentialSync';

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

export async function syncCredentials(): Promise<SyncResult> {
  const session = await AuthService.getSession();
  if (!session) {
    return { success: false, message: 'Not authenticated' };
  }

  const credentialsJson = readCodexAuthFile();
  logConsole(LOG_COMPONENT, `Codex auth file found: ${credentialsJson !== null}`);
  if (credentialsJson === null) {
    return {
      success: false,
      message: 'Codex credentials not found. Please run codex login in Terminal.',
    };
  }

  const validation = validateCredentials(credentialsJson);
  if (validation !== null) return validation;

  try {
    await uploadCredentials(credentialsJson, session.access_token);
    IntegrationCache.invalidate();
    logConsole(LOG_COMPONENT, 'Credentials synced successfully');
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logConsoleError(LOG_COMPONENT, 'Upload failed', error);
    return { success: false, message };
  }
}
