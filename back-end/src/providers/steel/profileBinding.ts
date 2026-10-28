import { INVALIDATED_STEEL_PROFILE_SOURCE } from '../browser/profileBinding';
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

/**
 * The recorded provider profile id that Steel may legitimately reload.
 *
 * Only a prior STEEL session's recorded profile is a valid Steel profile id.
 * On a provider switch (e.g. the rotate ladder's Kernel → Steel rung) the
 * recorded providerProfileId belongs to the other provider — a non-UUID Kernel
 * profile — which Steel rejects with "400 profileId must be a valid UUID".
 * Returns null for any non-Steel-origin or unrecorded profile so the caller
 * falls back to the context's Steel-native persisted profile (or none).
 */
export function reusableSteelRecordedProfileId(oldSession: {
  provider: string;
  providerProfileId?: string | null;
  // Required on purpose: an object literal that omits this compiles with
  // `undefined`, which passes the invalidated-source check below and reuses a
  // profile that was explicitly invalidated. Every caller reads a Prisma row,
  // so they can all supply it.
  providerProfileSource: string | null;
}): string | null {
  const wasSteel = oldSession.provider === 'steel';
  return wasSteel &&
    oldSession.providerProfileSource !== INVALIDATED_STEEL_PROFILE_SOURCE &&
    typeof oldSession.providerProfileId === 'string' &&
    oldSession.providerProfileId !== ''
    ? oldSession.providerProfileId
    : null;
}
