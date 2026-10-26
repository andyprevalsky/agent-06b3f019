import { AuthService } from '../../services/auth';
import { IMessageReader } from '../../services/iMessageReader';
import { BatchUploader } from '../../services/batchUploader';
import { IntegrationProgress, type ProgressRun } from '../../services/integrationProgress';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { sessionForLocalMachineData } from '../../base/impersonation';
import type {
  AuthSession,
  IMessageData,
  Integration,
  NormalizedMessage,
  UploadResult,
} from './types';

/**
 * Fetch the current authenticated session, if any.
 */
export async function getSession(): Promise<AuthSession | null> {
  return sessionForLocalMachineData(await AuthService.getSession());
}

/**
 * True if the local process can read the iMessage SQLite DB and native contacts.
 */
export function checkIMessageAccess(): boolean {
  return IMessageReader.checkAccess();
}

/**
 * Max ROWID currently present in the iMessage DB (0 when inaccessible).
 */
export function getMaxIMessageRowId(): number {
  return IMessageReader.getMaxRowId();
}

/**
 * Read iMessages (optionally filtered by a last-access timestamp, for incremental sync).
 */
export async function readIMessages(
  lastAccessedAt: string | undefined,
  isIncremental: boolean
): Promise<IMessageData[]> {
  return IMessageReader.readMessages(lastAccessedAt, isIncremental);
}

/**
 * Read iMessages with ROWID > sinceRowId (real-time watcher path).
 */
export async function readIMessagesSinceRowId(sinceRowId: number): Promise<IMessageData[]> {
  return IMessageReader.readMessagesSinceRowId(sinceRowId);
}

/**
 * Convert raw IMessageData rows to the platform-neutral NormalizedMessage shape.
 */
export function toNormalizedMessages(rows: IMessageData[]): NormalizedMessage[] {
  return IMessageReader.toNormalizedMessages(rows);
}

/**
 * Lookup the cached integration record by name (may be undefined if never fetched).
 */
export async function getIntegration(name: string): Promise<Integration | undefined> {
  return IntegrationCache.getIntegration(name);
}

/**
 * True if the named integration is in the CONNECTED set in cache.
 */
export async function isIntegrationConnected(name: string): Promise<boolean> {
  return IntegrationCache.isConnected(name);
}

/**
 * Start a best-effort sync-progress run for the `imessage` Integration row.
 */
export function startImessageProgressRun(): ProgressRun {
  return IntegrationProgress.startRun('imessage');
}

/**
 * Upload a payload via the BatchUploader for the given integration type.
 */
export async function uploadImessagePayload(
  data: unknown,
  accessToken: string
): Promise<UploadResult> {
  return BatchUploader.uploadInBatches('imessage', data, accessToken, null);
}
