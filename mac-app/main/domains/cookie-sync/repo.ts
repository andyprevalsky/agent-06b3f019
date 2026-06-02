import { AuthService } from '../../services/auth';
import { IntegrationCache } from '../../services/sync/IntegrationCache';
import { BrowserCookieReader } from '../../services/browserCookieReader';
import { BatchUploader } from '../../services/batchUploader';
import { COOKIE_SYNC_INTEGRATION } from './config';
import type { AuthSession, CookieData, UploadResult } from './types';

/**
 * Data-access layer for cookie-sync. Each function is a thin, typed wrapper
 * around an external data source (auth store, integration cache, browser
 * cookie reader, upload transport). The service layer composes these — the service
 * never touches `AuthService`/`IntegrationCache`/`BrowserCookieReader`/`BatchUploader`
 * directly so collaborators can be swapped without touching business logic.
 */

export async function fetchCurrentSession(): Promise<AuthSession | null> {
  return AuthService.getSession();
}

export async function isIntegrationConnected(): Promise<boolean> {
  return IntegrationCache.isConnected(COOKIE_SYNC_INTEGRATION);
}

export async function readCookies(): Promise<CookieData[]> {
  return BrowserCookieReader.readCookies('chrome');
}

export async function uploadCookies(
  cookies: CookieData[],
  accessToken: string
): Promise<UploadResult> {
  return BatchUploader.uploadInBatches(COOKIE_SYNC_INTEGRATION, cookies, accessToken, null);
}
