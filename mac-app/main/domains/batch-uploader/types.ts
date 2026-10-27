/**
 * batch-uploader — types layer
 *
 * The batch uploader is a thin logging wrapper around the Uploader service
 * (a separate domain). It consumes the shared `UploadResult` IPC contract
 * and forwards the original input `unknown` payload through to Uploader
 * unchanged, so it has no domain-specific value-shape types.
 *
 * Layer rule: types imports nothing from the project source tree (external
 * packages + shared IPC types only).
 */

import type { MessagingUploadOptions, UploadResult } from '../../../shared/types/ipc';

/**
 * Re-export the cross-cutting IPC result shape used by callers (handlers,
 * sibling domains) so they can depend on the batch-uploader barrel without
 * reaching into `shared/types/ipc`.
 */
export type { MessagingUploadOptions, UploadResult };
