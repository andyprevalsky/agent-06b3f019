import { createHash } from 'node:crypto';
import type { HubRunSummary } from './benchmarkHubStore';

type PutRun = (
  bundle: Record<string, unknown>,
  options?: { live?: boolean; source?: string }
) => Promise<HubRunSummary>;

/** Share consecutive identical pending packets for one persisted run identity. */
export function coalesceHubRunPuts(publish: PutRun): PutRun {
  const pendingRunPuts = new Map<string, { key: string; pending: Promise<HubRunSummary> }>();
  return (bundle, options = {}) => {
    let runId: string;
    let key: string;
    try {
      runId = String(bundle.run_id ?? '');
      const source = options.source ?? (typeof bundle.source === 'string' ? bundle.source : null);
      key = createHash('sha256')
        .update(JSON.stringify([options.live === true, source, bundle]))
        .digest('hex');
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = pendingRunPuts.get(runId);
    if (existing?.key === key) return existing.pending;
    const pending = publish(bundle, options);
    pendingRunPuts.set(runId, { key, pending });
    const release = () => {
      if (pendingRunPuts.get(runId)?.pending === pending) pendingRunPuts.delete(runId);
    };
    void pending.then(release, release);
    return pending;
  };
}
