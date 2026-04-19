import { ORIGINS_PER_BATCH } from './config';
import { uploadLocalStorageBatch } from './repo';
import { withRetry } from './service-retry';
import type { LocalStorageBatch, LocalStorageData, UploadResult } from './types';

/** Split localStorage data into origin-chunked batches. */
export function splitLocalStorageIntoBatches(data: LocalStorageData): LocalStorageBatch[] {
  const origins = Object.keys(data.byOrigin);
  const totalBatches = Math.ceil(origins.length / ORIGINS_PER_BATCH);
  const batches: LocalStorageBatch[] = [];

  for (let i = 0; i < origins.length; i += ORIGINS_PER_BATCH) {
    const batchOrigins = origins.slice(i, i + ORIGINS_PER_BATCH);
    const byOrigin: Record<string, { key: string; value: string }[]> = {};
    const hashes: Record<string, string> = {};
    let entryCount = 0;

    for (const origin of batchOrigins) {
      byOrigin[origin] = data.byOrigin[origin];
      hashes[origin] = data.hashes[origin];
      entryCount += data.byOrigin[origin].length;
    }

    batches.push({
      byOrigin,
      hashes,
      batchIndex: batches.length,
      totalBatches,
      entryCount,
      originCount: batchOrigins.length,
    });
  }

  return batches;
}

async function uploadBatch(batch: LocalStorageBatch, accessToken: string): Promise<UploadResult> {
  const result = await withRetry(
    () => uploadLocalStorageBatch(batch, accessToken),
    `Batch ${batch.batchIndex + 1}`
  );
  if (result.success) {
    console.log(
      `[BrowserStateSync] \u2705 Batch ${batch.batchIndex + 1}/${batch.totalBatches} uploaded (${batch.originCount} origins, ${batch.entryCount} entries)`
    );
  }
  return result;
}

/** Upload all localStorage batches in parallel. Aggregates failures. */
export async function uploadLocalStorageInBatches(
  data: LocalStorageData,
  accessToken: string
): Promise<UploadResult> {
  const batches = splitLocalStorageIntoBatches(data);

  console.log(
    `[BrowserStateSync] Uploading localStorage in ${batches.length} batches (${data.originCount} origins, ${data.entryCount} entries)`
  );

  const uploadResults = await Promise.all(batches.map((batch) => uploadBatch(batch, accessToken)));

  const failedBatches = uploadResults
    .map((result, index) => (result.success ? null : index))
    .filter((index): index is number => index !== null);

  if (failedBatches.length > 0) {
    const failedLabel = failedBatches.map((i) => i + 1).join(', ');
    console.error(`[BrowserStateSync] \u274c Failed batches: ${failedLabel} of ${batches.length}`);
    return {
      success: false,
      message: `Failed batches: ${failedLabel} of ${batches.length}`,
    };
  }

  console.log(`[BrowserStateSync] \u2705 All ${batches.length} batches uploaded`);
  return { success: true };
}
