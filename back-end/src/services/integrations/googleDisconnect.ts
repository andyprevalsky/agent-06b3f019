import { prisma } from '../../providers/database';
import { revokeGoogleGrant } from '../../providers/googleRevoke';
import { createLogger } from '../../providers/logger';

const log = createLogger('GoogleDisconnect');

export interface QueuedGoogleRevocation {
  id: string;
  token: string | null;
}

/** Try revocation immediately after the purge obligation commits. The job retries failures. */
export async function revokeQueuedGoogleGrants(
  jobs: QueuedGoogleRevocation[],
  fetcher: typeof fetch = fetch
): Promise<void> {
  for (const job of jobs) {
    if (job.token === null) continue;
    try {
      await revokeGoogleGrant(job.token, null, fetcher);
      await prisma.googleDataPurge.update({
        where: { id: job.id },
        data: { revocationToken: null },
      });
    } catch {
      log.error('Google revocation queued for retry', { jobId: job.id });
    }
  }
}
