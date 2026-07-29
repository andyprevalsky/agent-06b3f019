import { benchmarkIsolatedBrowserProfilesEnabled } from '../browser/benchmarkProfileIsolation';
import { log } from './types';

const benchmarkAnonProfilesByAgent = new Map<string, string>();

export function envEnabled(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off', 'disabled'].includes(raw.trim().toLowerCase());
}

function benchmarkAnonSteelProfileEnabled(): boolean {
  return (
    benchmarkIsolatedBrowserProfilesEnabled() ||
    ['1', 'true', 'yes'].includes(
      (process.env.BENCHMARK_ANON_STEEL_PROFILE ?? '').trim().toLowerCase()
    )
  );
}

export function resolveSteelProfileForSession(
  agentId: string | null,
  persistedProfileId: string | null,
  requiredProfileId: string | null = null,
  boundProfile?: {
    profileId: string;
    profileSource: string;
    persistProfile: boolean;
  }
) {
  if (!envEnabled('BROWSER_AGENT_STEEL_PROFILE_ENABLED', true)) {
    if (requiredProfileId !== null || boundProfile !== undefined) {
      throw new Error('A bound Steel session requires browser profile support');
    }
    return {
      profileId: undefined,
      profileSource: 'disabled',
      persistProfile: false,
    } as const;
  }

  if (boundProfile !== undefined) return boundProfile;

  if (requiredProfileId !== null) {
    const readOnly = benchmarkAnonSteelProfileEnabled();
    return {
      profileId: requiredProfileId,
      profileSource: readOnly ? 'steel_session_auth_read_only' : 'steel_session_auth',
      // Isolated benchmark agents may concurrently load the same authenticated
      // snapshot, but must never write their cookies/storage back to it.
      persistProfile: !readOnly,
    } as const;
  }

  if (!benchmarkAnonSteelProfileEnabled()) {
    return {
      profileId: persistedProfileId ?? undefined,
      profileSource: persistedProfileId ? 'user_persistent' : 'new_user_persistent',
      persistProfile: true,
    } as const;
  }

  const benchmarkProfileId =
    agentId === null ? undefined : benchmarkAnonProfilesByAgent.get(agentId);
  return {
    profileId: benchmarkProfileId,
    profileSource: benchmarkProfileId ? 'benchmark_anon_persistent' : 'benchmark_anon_fresh',
    persistProfile: true,
  } as const;
}

export function rememberBenchmarkAnonSteelProfile(
  agentId: string | null,
  profileId: string | null | undefined
) {
  if (agentId === null || !benchmarkAnonSteelProfileEnabled() || !profileId) return;
  if (!benchmarkAnonProfilesByAgent.has(agentId)) {
    benchmarkAnonProfilesByAgent.set(agentId, profileId);
    log.info(`  🧪 Captured benchmark anon Steel profileId for agent ${agentId}: ${profileId}`);
  }
}

export function shouldWriteSteelProfileToBrowserContext(profile: {
  profileSource: string;
  persistProfile: boolean;
}): boolean {
  return (
    profile.persistProfile &&
    !profile.profileSource.startsWith('benchmark_anon') &&
    profile.profileSource !== 'steel_session_auth_read_only'
  );
}
