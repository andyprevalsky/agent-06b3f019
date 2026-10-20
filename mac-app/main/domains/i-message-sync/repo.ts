/**
 * i-message-sync — repo layer: every boundary of the iMessage sync.
 *
 *   session (AuthService) · chat.db (IMessageReader) · integration rows
 *   (IntegrationCache) · batch uploads (Uploader) · progress POST (fetch)
 *   · Mac identity (deviceIdentity) · local run state (userData JSON file)
 */

import { app } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../../base/config';
import { sessionForLocalMachineData } from '../../base/impersonation';
import { AuthService } from '../../services/auth';
import { macDeviceId, macDeviceName } from '../../services/deviceIdentity';
import { IMessageReader } from '../../services/iMessageReader';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { Uploader } from '../../services/uploader';
import { INTEGRATION_NAME, progressPath, SYNC_STATE_FILE } from './config';
import type {
  AccountMode,
  AuthSession,
  DeviceUploadResult,
  IMessageData,
  Integration,
  NormalizedMessage,
  ProgressHttpResult,
  SyncStateFile,
} from './types';
import type { ContactRecord } from '../../services/contactsReaderNative';

/** Label length the backend accepts for a device account. */
const LABEL_MAX_LENGTH = 120;

export async function getSession(): Promise<AuthSession | null> {
  return sessionForLocalMachineData(await AuthService.getSession());
}

/** The signed-in user's id (sync state is kept per user on a shared Mac). */
export function sessionUserId(session: AuthSession): string | null {
  const user = session.user as { id?: unknown } | null | undefined;
  return typeof user?.id === 'string' && user.id !== '' ? user.id : null;
}

export function checkIMessageAccess(): boolean {
  return IMessageReader.checkAccess();
}

export function getMaxIMessageRowId(): number {
  return IMessageReader.getMaxRowId();
}

export function countMessageRows(afterRowId: number): { total: number; maxRowId: number } {
  return IMessageReader.countMessageRows(afterRowId);
}

export async function loadSyncContacts(): Promise<Map<string, ContactRecord>> {
  return IMessageReader.loadSyncContacts();
}

export function readMessageBatch(
  afterRowId: number,
  upToRowId: number,
  limit: number,
  contacts: Map<string, ContactRecord>
): { messages: IMessageData[]; scanned: number; lastRowId: number } {
  return IMessageReader.readMessageBatch({ afterRowId, upToRowId, limit }, contacts);
}

export async function readIMessagesSinceRowId(sinceRowId: number): Promise<IMessageData[]> {
  return IMessageReader.readMessagesSinceRowId(sinceRowId);
}

export function toNormalizedMessages(rows: IMessageData[]): NormalizedMessage[] {
  return IMessageReader.toNormalizedMessages(rows);
}

/** Every iMessage account row of this user (one per Mac, plus a legacy '' row). */
export async function getIMessageAccounts(): Promise<Integration[]> {
  return IntegrationCache.getAccounts(INTEGRATION_NAME);
}

/** Drop the cached integration rows so the next read sees a just-created account. */
export function invalidateIntegrations(): void {
  IntegrationCache.invalidate();
}

/** This Mac's account id and label. */
export function deviceAccount(): { id: string; label: string | null } {
  const label = macDeviceName().trim().slice(0, LABEL_MAX_LENGTH);
  return { id: macDeviceId(), label: label === '' ? null : label };
}

export async function uploadDeviceBatch(
  data: readonly unknown[],
  accessToken: string,
  account: { id: string; label: string | null; mode: AccountMode }
): Promise<DeviceUploadResult> {
  return Uploader.uploadIMessageDeviceBatch(data, accessToken, account);
}

/** POST one progress write. Never throws: transport failures read as status 0. */
export async function postProgress(
  accountId: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<ProgressHttpResult> {
  try {
    const response = await fetch(`${config.apiUrl}${progressPath(accountId)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as {
      retryAfterMs?: unknown;
      detail?: unknown;
    };
    return {
      status: response.status,
      retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : null,
      staleDetail: typeof data.detail === 'string' ? data.detail : null,
    };
  } catch {
    return { status: 0, retryAfterMs: null, staleDetail: null };
  }
}

export function newRunId(): string {
  return crypto.randomUUID();
}

function stateFilePath(): string {
  return path.join(app.getPath('userData'), SYNC_STATE_FILE);
}

/** The persisted sync state; a missing or unreadable file reads as empty. */
export function readStateFile(): SyncStateFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as SyncStateFile;
    if (parsed.version === 1 && typeof parsed.users === 'object' && parsed.users !== null) {
      return parsed;
    }
  } catch {
    // first run or a corrupt file: start over (the backend dedups re-uploads)
  }
  return { version: 1, users: {} };
}

/** Atomic replace (write + rename) so a crash never leaves a torn state file. */
export function writeStateFile(state: SyncStateFile): void {
  const file = stateFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
