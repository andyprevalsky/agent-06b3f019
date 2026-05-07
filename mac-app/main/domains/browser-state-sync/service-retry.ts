import { MAX_RETRIES, RETRY_DELAY_MS } from './config';
import { toError } from '../../../shared/utils/error';
import type { UploadResult } from './types';

/**
 * Run an async uploader with exponential-backoff retry semantics.
 * Returns UploadResult instead of throwing so callers can batch-aggregate.
 */
export async function withRetry(
  uploader: () => Promise<void>,
  label: string
): Promise<UploadResult> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await uploader();
      return { success: true };
    } catch (error) {
      lastError = toError(error);
      console.warn(
        `[BrowserStateSync] ${label} upload attempt ${attempt + 1} failed:`,
        lastError.message
      );

      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  const message = lastError?.message ?? 'Unknown error after retries';
  return { success: false, message };
}
