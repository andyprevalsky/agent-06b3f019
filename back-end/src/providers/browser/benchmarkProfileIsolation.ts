import type Kernel from '@onkernel/sdk';
import { createLogger } from '../logger';

const log = createLogger('BenchmarkProfileIsolation');

// Local benchmark stacks share one backend process. Keying provider profiles by
// agent preserves in-agent session/rotation continuity without funneling every
// concurrent benchmark through the benchmark user's one persistent profile.
const kernelProfilesByAgent = new Map<string, Promise<string>>();

/**
 * Local benchmark stacks run many agents against one database and backend.
 * This flag gives each browser agent its own provider profile, so concurrent
 * sessions cannot overwrite another benchmark's cookies, storage, or tabs.
 */
export function benchmarkIsolatedBrowserProfilesEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES ?? '').trim().toLowerCase()
  );
}

export async function getOrCreateBenchmarkKernelProfile(
  client: Kernel,
  agentId: string
): Promise<{ profileId: string; profileSource: string }> {
  const existing = kernelProfilesByAgent.get(agentId);
  if (existing !== undefined) {
    return { profileId: await existing, profileSource: 'user_persistent' };
  }

  const pending = client.profiles.create({}).then((profile) => profile.id);
  kernelProfilesByAgent.set(agentId, pending);
  try {
    return { profileId: await pending, profileSource: 'new_user_persistent' };
  } catch (error) {
    if (kernelProfilesByAgent.get(agentId) === pending) {
      kernelProfilesByAgent.delete(agentId);
    }
    throw error;
  }
}

export async function cleanupBenchmarkKernelProfiles(client: Kernel): Promise<void> {
  if (kernelProfilesByAgent.size === 0) return;

  const profiles = [...kernelProfilesByAgent.entries()];
  kernelProfilesByAgent.clear();
  const results = await Promise.allSettled(
    profiles.map(async ([agentId, pending]) => {
      const profileId = await pending;
      await client.profiles.delete(profileId);
      return { agentId, profileId };
    })
  );
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    const [agentId] = profiles[index];
    log.warn('Failed to delete isolated benchmark Kernel profile during shutdown', {
      agentId,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
  }
}
