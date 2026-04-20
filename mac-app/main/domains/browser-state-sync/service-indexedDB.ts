import { ORIGINS_PER_BATCH } from './config';
import { uploadIndexedDBBatch } from './repo';
import { withRetry } from './service-retry';
import type { IndexedDBBatch, IndexedDBData, UploadResult } from './types';

/** Split IndexedDB data into origin-chunked batches. */
export function splitIndexedDBIntoBatches(data: IndexedDBData): IndexedDBBatch[] {
  const origins = data.origins;
  const totalBatches = Math.ceil(origins.length / ORIGINS_PER_BATCH);
  const batches: IndexedDBBatch[] = [];

  for (let i = 0; i < origins.length; i += ORIGINS_PER_BATCH) {
    const batchOrigins = origins.slice(i, i + ORIGINS_PER_BATCH);
    const hashes: Record<string, string> = {};

    for (const origin of batchOrigins) {
      const hash = data.hashes[origin.origin];
      if (typeof hash === 'string' && hash.length > 0) {
        hashes[origin.origin] = hash;
      }
    }

    batches.push({
      origins: batchOrigins,
      hashes,
      batchIndex: batches.length,
      totalBatches,
    });
  }

  return batches;
}

async function uploadBatch(batch: IndexedDBBatch, accessToken: string): Promise<UploadResult> {
  const result = await withRetry(
    () => uploadIndexedDBBatch(batch, accessToken),
    `IndexedDB batch ${batch.batchIndex + 1}`
  );
  if (result.success) {
    console.log(
      `[BrowserStateSync] \u2705 IndexedDB batch ${batch.batchIndex + 1}/${batch.totalBatches} uploaded (${batch.origins.length} origins)`
    );
  }
  return result;
}

/** Upload all IndexedDB batches in parallel. Aggregates failures. */
export async function uploadIndexedDBInBatches(
  data: IndexedDBData,
  accessToken: string
): Promise<UploadResult> {
  if (data.origins.length === 0) {
    return { success: true };
  }

  const batches = splitIndexedDBIntoBatches(data);

  console.log(
    `[BrowserStateSync] Uploading IndexedDB in ${batches.length} batches (${data.origins.length} origins)`
  );

  const uploadResults = await Promise.all(batches.map((batch) => uploadBatch(batch, accessToken)));

  const failedBatches = uploadResults
    .map((result, index) => (result.success ? null : index))
    .filter((index): index is number => index !== null);

  if (failedBatches.length > 0) {
    const failedLabel = failedBatches.map((i) => i + 1).join(', ');
    console.error(
      `[BrowserStateSync] \u274c Failed IndexedDB batches: ${failedLabel} of ${batches.length}`
    );
    return {
      success: false,
      message: `Failed batches: ${failedLabel} of ${batches.length}`,
    };
  }

  console.log(`[BrowserStateSync] \u2705 All ${batches.length} IndexedDB batches uploaded`);
  return { success: true };
}
