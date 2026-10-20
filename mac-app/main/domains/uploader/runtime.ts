/**
 * uploader — runtime layer
 *
 * Thin public entry for the upload domain. Exposes the {@link Uploader}
 * static class used by higher-level callers (BatchUploader, per-platform
 * syncs, IPC handlers) and by blackbox tests. Responsibilities:
 *   1. Fan out progress events on the provided BrowserWindow.
 *   2. Delegate strategy resolution + dispatch to the service layer.
 *   3. Translate HTTP/transport failures into {@link UploadResult}.
 *
 * Layer rule: runtime imports own service + own types/config + shared
 * providers only. No raw fetch, no inline business logic, no crypto.
 */

import type { BrowserWindow } from 'electron';
import {
  UPLOAD_PROGRESS_CHANNEL,
  UPLOAD_PROGRESS_DONE_PERCENT,
  UPLOAD_PROGRESS_START_PERCENT,
} from './config';
import {
  accessTokenIsImpersonated,
  IMPERSONATED_MACHINE_DATA_MESSAGE,
} from '../../base/impersonation';
import { getErrorMessageOrFallback } from '../../../shared/utils/error';
import { postIntegrationProgress, postWhatsAppConnect, postWhatsAppContacts } from './repo';
import {
  dispatchUploadWithTransportRetry,
  resolveStrategy,
  toIntegrationProgressResult,
} from './service';
import type { IntegrationProgressResult, UploadResult } from './types';

/** Emit an `upload:progress` event on the supplied renderer window, if any. */
function emitProgress(
  window: BrowserWindow | null,
  integrationType: string,
  percent: number
): void {
  window?.webContents.send(UPLOAD_PROGRESS_CHANNEL, { type: integrationType, percent });
}

export class Uploader {
  /**
   * Mark the WhatsApp integration CONNECTED before any messages exist.
   *
   * The uploader refuses to flush until the integration reads as connected,
   * and the integration row is otherwise only created by an upload — so the
   * first sync after pairing deadlocks without this call.
   */
  static async registerWhatsAppConnected(
    accessToken: string,
    account: { accountId: string; label: string } | null = null
  ): Promise<UploadResult> {
    try {
      const result = await postWhatsAppConnect(accessToken, account);
      if (!result.ok) {
        throw new Error(`WhatsApp connect failed: ${result.statusText}`);
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: getErrorMessageOrFallback(error, 'WhatsApp connect failed'),
      };
    }
  }

  /**
   * Upload one WhatsApp account's contacts batch. `accountId` (the linked
   * phone) attributes the messages; null keeps the legacy single-account row.
   */
  static async uploadWhatsAppContacts(
    contacts: unknown,
    accessToken: string,
    accountId: string | null
  ): Promise<UploadResult> {
    if (accessTokenIsImpersonated(accessToken)) {
      return { success: false, message: IMPERSONATED_MACHINE_DATA_MESSAGE };
    }
    try {
      const result = await postWhatsAppContacts(contacts, accessToken, accountId);
      if (!result.ok) throw new Error(`Upload failed: ${result.statusText}`);
      return { success: true };
    } catch (error) {
      return { success: false, message: getErrorMessageOrFallback(error) };
    }
  }

  /**
   * Report one account's sync progress (POST .../accounts/:accountId/progress).
   * Never throws: transport errors read as `failed` so the caller backs off.
   */
  static async reportIntegrationProgress(
    provider: string,
    accountId: string,
    body: unknown,
    accessToken: string
  ): Promise<IntegrationProgressResult> {
    if (accessTokenIsImpersonated(accessToken)) return { kind: 'stale' };
    try {
      const response = await postIntegrationProgress(provider, accountId, body, accessToken);
      return toIntegrationProgressResult(response.status, response.body);
    } catch {
      return { kind: 'failed' };
    }
  }

  /**
   * Upload a payload for the given integration type. Route selection,
   * encryption, and payload shaping are delegated to the service layer.
   */
  static async uploadData(
    integrationType: string,
    data: unknown,
    accessToken: string,
    window: BrowserWindow | null
  ): Promise<UploadResult> {
    // Final owning boundary for every BatchUploader payload. Orchestration and
    // IPC guards avoid reading local data unnecessarily, but this check makes a
    // missed caller unable to write this Mac's data into an impersonated user.
    if (accessTokenIsImpersonated(accessToken)) {
      return { success: false, message: IMPERSONATED_MACHINE_DATA_MESSAGE };
    }
    try {
      emitProgress(window, integrationType, UPLOAD_PROGRESS_START_PERCENT);

      const strategy = resolveStrategy(integrationType);
      const result = await dispatchUploadWithTransportRetry(
        strategy,
        integrationType,
        data,
        accessToken
      );

      emitProgress(window, integrationType, UPLOAD_PROGRESS_DONE_PERCENT);

      if (!result.ok) {
        throw new Error(`Upload failed: ${result.statusText}`);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: getErrorMessageOrFallback(error),
      };
    }
  }
}
