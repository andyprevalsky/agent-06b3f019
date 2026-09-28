import type Kernel from '@onkernel/sdk';
import { createLogger } from '../logger';

const log = createLogger('BenchmarkProfileIsolation');

type AgentKernelProfile = {
  profileIdPromise: Promise<string>;
  /**
   * True once a Kernel browser session successfully used this profile.
   * Until then, retries must keep advertising `new_user_persistent` — a
   * timed-out/failed first init that only reserved the in-memory slot must
   * not poison isolation proofs (webdecoy expects new_user_persistent on the
   * first published session_init metadata).
   */
  boundToSession: boolean;
};

// Local benchmark stacks share one backend process. Keying provider profiles by
// agent preserves in-agent session/rotation continuity without funneling every
// concurrent benchmark through the benchmark user's one persistent profile.
const kernelProfilesByAgent = new Map<string, AgentKernelProfile>();

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
    return {
      profileId: await existing.profileIdPromise,
      profileSource: existing.boundToSession ? 'user_persistent' : 'new_user_persistent',
    };
  }

  const pending = client.profiles.create({}).then((profile) => profile.id);
  const entry: AgentKernelProfile = { profileIdPromise: pending, boundToSession: false };
  kernelProfilesByAgent.set(agentId, entry);
  try {
    return { profileId: await pending, profileSource: 'new_user_persistent' };
  } catch (error) {
    if (kernelProfilesByAgent.get(agentId) === entry) {
      kernelProfilesByAgent.delete(agentId);
    }
    throw error;
  }
}

/** Mark the agent's isolated Kernel profile as successfully bound to a session. */
export function markBenchmarkKernelProfileBound(agentId: string): void {
  const entry = kernelProfilesByAgent.get(agentId);
  if (entry === undefined) return;
  entry.boundToSession = true;
}

/** Test-only: clear in-memory isolated profile state between cases. */
export function resetBenchmarkKernelProfilesForTests(): void {
  kernelProfilesByAgent.clear();
}

export async function cleanupBenchmarkKernelProfiles(client: Kernel): Promise<void> {
  if (kernelProfilesByAgent.size === 0) return;

  const profiles = [...kernelProfilesByAgent.entries()];
  kernelProfilesByAgent.clear();
  const results = await Promise.allSettled(
    profiles.map(async ([agentId, entry]) => {
      const profileId = await entry.profileIdPromise;
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
