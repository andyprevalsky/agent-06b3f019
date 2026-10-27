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
import { postWhatsAppConnect } from './repo';
import { dispatchUploadWithTransportRetry, resolveStrategy } from './service';
import type { MessagingUploadOptions, UploadResult } from './types';

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
  static async registerWhatsAppConnected(accessToken: string): Promise<UploadResult> {
    try {
      const result = await postWhatsAppConnect(accessToken);
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
   * Upload a payload for the given integration type. Route selection,
   * encryption, and payload shaping are delegated to the service layer.
   */
  static async uploadData(
    integrationType: string,
    data: unknown,
    accessToken: string,
    window: BrowserWindow | null,
    options: MessagingUploadOptions = {}
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
        accessToken,
        options
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
