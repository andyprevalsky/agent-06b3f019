import { createHash } from 'node:crypto';
import type { HubRunSummary } from './benchmarkHubStore';

type PutRun = (
  bundle: Record<string, unknown>,
  options?: { live?: boolean; source?: string }
) => Promise<HubRunSummary>;

/** Share identical pending packets before they create another index admission. */
export function coalesceHubRunPuts(publish: PutRun): PutRun {
  const pendingRunPuts = new Map<string, Promise<HubRunSummary>>();
  return (bundle, options = {}) => {
    let key: string;
    try {
      const source = options.source ?? (typeof bundle.source === 'string' ? bundle.source : null);
      key = createHash('sha256')
        .update(JSON.stringify([options.live === true, source, bundle]))
        .digest('hex');
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = pendingRunPuts.get(key);
    if (existing !== undefined) return existing;
    const pending = publish(bundle, options);
    pendingRunPuts.set(key, pending);
    const release = () => {
      pendingRunPuts.delete(key);
    };
    void pending.then(release, release);
    return pending;
  };
}
