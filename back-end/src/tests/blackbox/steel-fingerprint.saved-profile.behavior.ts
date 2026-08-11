import {
  resolveSteelProfileForSession,
  shouldWriteSteelProfileToBrowserContext,
} from '../../providers/steel/session';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

export function testSavedSteelProfileIsReadOnlyDuringBenchmarkIsolation(): void {
  const previousIsolated = process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
  const previousProfileEnabled = process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
  process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = 'true';
  process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = 'true';
  try {
    const profile = resolveSteelProfileForSession(
      'agent-1',
      'shared-browser-context',
      'steel-auth-profile'
    );

    assert(
      profile.profileId === 'steel-auth-profile',
      'isolated saved auth must load the authenticated Steel snapshot'
    );
    assert(
      profile.profileSource === 'steel_session_auth_read_only',
      'isolated saved auth must be distinguishable from mutable anonymous profiles'
    );
    assert(
      profile.persistProfile === false,
      'isolated saved auth sessions must never write back to the shared Steel profile'
    );
    assert(
      !shouldWriteSteelProfileToBrowserContext(profile),
      'isolated saved auth must not overwrite BrowserContext.contextId'
    );
  } finally {
    if (previousIsolated === undefined) {
      delete process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
    } else {
      process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = previousIsolated;
    }
    if (previousProfileEnabled === undefined) {
      delete process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
    } else {
      process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = previousProfileEnabled;
    }
  }
}

export function testSavedSteelProfilePersistenceByEnvironment(): void {
  const previousIsolated = process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
  const previousAnon = process.env.BENCHMARK_ANON_STEEL_PROFILE;
  const previousProfileEnabled = process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
  process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = 'false';
  process.env.BENCHMARK_ANON_STEEL_PROFILE = 'false';
  process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = 'true';
  try {
    const profile = resolveSteelProfileForSession(
      'agent-prod',
      'shared-browser-context',
      'steel-auth-profile'
    );
    assert(
      profile.profileId === 'steel-auth-profile',
      'production must use the saved Steel profile'
    );
    assert(
      profile.profileSource === 'steel_session_auth',
      'production source must remain explicit'
    );
    assert(
      profile.persistProfile === true,
      'normal production must keep profile persistence enabled'
    );
  } finally {
    if (previousIsolated === undefined) delete process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
    else process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = previousIsolated;
    if (previousAnon === undefined) delete process.env.BENCHMARK_ANON_STEEL_PROFILE;
    else process.env.BENCHMARK_ANON_STEEL_PROFILE = previousAnon;
    if (previousProfileEnabled === undefined) {
      delete process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
    } else {
      process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = previousProfileEnabled;
    }
  }
}

export function testSavedSteelResolutionDoesNotContaminateAnonymousProfiles(): void {
  const previousIsolated = process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
  const previousProfileEnabled = process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
  process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = 'true';
  process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = 'true';
  try {
    const agentId = `isolation-${Date.now()}`;
    const saved = resolveSteelProfileForSession(
      agentId,
      'shared-browser-context',
      'steel-auth-profile'
    );
    const anonymous = resolveSteelProfileForSession(agentId, 'shared-browser-context');

    assert(saved.persistProfile === false, 'saved snapshot must be read-only');
    assert(
      anonymous.profileId === undefined,
      'loading saved auth must not populate the anonymous per-agent profile map'
    );
    assert(
      anonymous.profileSource === 'benchmark_anon_fresh',
      'a later anonymous session must still receive a fresh isolated profile'
    );
  } finally {
    if (previousIsolated === undefined) {
      delete process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES;
    } else {
      process.env.BENCHMARK_ISOLATED_BROWSER_PROFILES = previousIsolated;
    }
    if (previousProfileEnabled === undefined) {
      delete process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED;
    } else {
      process.env.BROWSER_AGENT_STEEL_PROFILE_ENABLED = previousProfileEnabled;
    }
  }
}
