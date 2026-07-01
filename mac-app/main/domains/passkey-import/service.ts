/**
 * Passkey import (Apple Credential Exchange).
 *
 * When macOS hands Rose a Credential Exchange import token (the user transferring
 * their real iCloud passkeys from Apple Passwords into Rose), we run the native
 * `rose-passkey-import` helper, which calls ASCredentialImportManager and returns
 * passkeys (private keys included) plus basic-auth passwords as JSON. We then
 * upload them through the same encrypted endpoints the rest of the app uses.
 *
 * State machine:
 *   receive import token -> in-process native bridge importCredentials(token)
 *     -> bridge returns { success, payload: { passkeys, passwords } }
 *        -> map -> uploadPasskeys/uploadPasswords -> { success, counts }
 *     -> bridge error / bad JSON -> { success: false, message }
 *
 * The token delivery (NSUserActivity / open-url carrying ASCredentialImportToken)
 * is wired in index.ts; this module is delivery-agnostic — it just needs a token.
 */

import { join } from 'path';
import { app } from 'electron';
import { createRequire } from 'module';
import { uploadPasskeys, type PasskeyUploadEntry } from '../passkey-enroll/repo';
import { APPLE_PASSWORDS_PASSKEY_SOURCE } from '../passkey-enroll/config';
import { encryptPasswordToEnvelope } from '../browser-password-reader/service';
import { uploadPasswords } from '../browser-state-sync/service-simple-uploads';
import type { PasswordRecord } from '../browser-state-sync/types';
import { getErrorMessage } from '../../../shared/utils/error';

interface HelperPasskey {
  rpId: string;
  credentialId: string;
  privateKey: string;
  userHandle: string;
  userName: string;
  signCount: number;
}

interface HelperPassword {
  title: string;
  url: string;
  userName: string;
  password: string;
}

interface HelperImportPayload {
  passkeys: HelperPasskey[];
  passwords: HelperPassword[];
}

interface NativeImportResponse {
  success: boolean;
  payload?: HelperImportPayload;
  message?: string;
  domain?: string;
  code?: number;
}

interface NativeImportBridge {
  importCredentials(token: string): string;
}

export interface ImportResult {
  success: boolean;
  count?: number;
  passkeyCount?: number;
  passwordCount?: number;
  message?: string;
}

let nativeImporterForTest: ((token: string) => HelperImportPayload) | null = null;
const requireNative = createRequire(__filename);

/** Resolve the bundled native bridge path (dev: dist/native, packaged: Resources/native). */
function nativeBridgePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'rose-user-activity-bridge.node')
    : join(app.getAppPath(), 'dist', 'native', 'rose-user-activity-bridge.node');
}

function parseHelperPayload(output: string): HelperImportPayload {
  const parsed = JSON.parse(output || '{"passkeys":[],"passwords":[]}') as unknown;
  if (Array.isArray(parsed)) {
    return { passkeys: parsed as HelperPasskey[], passwords: [] };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const payload = parsed as Partial<HelperImportPayload>;
    return {
      passkeys: Array.isArray(payload.passkeys) ? payload.passkeys : [],
      passwords: Array.isArray(payload.passwords) ? payload.passwords : [],
    };
  }
  return { passkeys: [], passwords: [] };
}

function parseNativeImportResponse(output: string): HelperImportPayload {
  const parsed = JSON.parse(output) as unknown;
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`native import returned non-object JSON: ${output.slice(0, 200)}`);
  }

  const response = parsed as NativeImportResponse;
  if (response.success !== true) {
    const detail = [
      response.message ?? 'native import failed',
      response.domain !== undefined ? `domain=${response.domain}` : undefined,
      response.code !== undefined ? `code=${response.code}` : undefined,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' ');
    throw new Error(detail);
  }

  return parseHelperPayload(JSON.stringify(response.payload ?? { passkeys: [], passwords: [] }));
}

function loadNativeImportBridge(): NativeImportBridge {
  const bridge = requireNative(nativeBridgePath()) as Partial<NativeImportBridge>;
  if (typeof bridge.importCredentials !== 'function') {
    throw new Error('native passkey bridge is missing importCredentials(token)');
  }
  return bridge as NativeImportBridge;
}

/** Run the native in-process bridge for an import token; returns parsed credentials. */
function runNativeImporter(token: string): HelperImportPayload {
  if (nativeImporterForTest !== null) {
    return nativeImporterForTest(token);
  }
  return parseNativeImportResponse(loadNativeImportBridge().importCredentials(token));
}

function toUploadEntry(pk: HelperPasskey): PasskeyUploadEntry {
  return {
    rpId: pk.rpId,
    credentialId: pk.credentialId,
    privateKey: pk.privateKey,
    userHandle: pk.userHandle || null,
    signCount: typeof pk.signCount === 'number' ? pk.signCount : 0,
    origin: `https://${pk.rpId}`,
    browserSource: APPLE_PASSWORDS_PASSKEY_SOURCE,
  };
}

async function toPasswordRecord(pw: HelperPassword): Promise<PasswordRecord | null> {
  if (pw.password === '' || pw.url === '') {
    return null;
  }

  let origin = pw.url;
  try {
    origin = new URL(pw.url).origin;
  } catch {
    origin = pw.url;
  }

  const now = Date.now();
  return {
    origin,
    username: pw.userName,
    encryptedPassword: await encryptPasswordToEnvelope(pw.password),
    dateLastUsed: now,
    dateCreated: now,
    browserSource: 'apple_passwords',
  };
}

/** Import all credentials for a Credential Exchange token and upload them. */
export async function importPasskeysFromToken(
  token: string,
  accessToken: string
): Promise<ImportResult> {
  try {
    const { passkeys, passwords } = runNativeImporter(token);
    const passkeyCount = passkeys.length;
    let passwordCount = 0;

    if (passkeyCount > 0) {
      await uploadPasskeys({ passkeys: passkeys.map(toUploadEntry) }, accessToken);
    }

    if (passwords.length > 0) {
      const records = (await Promise.all(passwords.map(toPasswordRecord))).filter(
        (record): record is PasswordRecord => record !== null
      );
      if (records.length > 0) {
        const result = await uploadPasswords(records, accessToken);
        if (!result.success) {
          return { success: false, message: result.message ?? 'Password upload failed' };
        }
        passwordCount = records.length;
      }
    }

    const count = passkeyCount + passwordCount;
    return {
      success: true,
      count,
      passkeyCount,
      passwordCount,
      message: count === 0 ? 'No credentials in the transfer' : undefined,
    };
  } catch (error) {
    return { success: false, message: getErrorMessage(error) };
  }
}

export const __passkeyImportServiceTest = {
  parseNativeImportResponse,
  setNativeImporterForTest(importer: ((token: string) => HelperImportPayload) | null): void {
    nativeImporterForTest = importer;
  },
};
