export interface ProviderProfileBinding {
  profileId: string;
  profileSource: string;
  /**
   * Whether a differing/absent loaded profile id is a FATAL mismatch. Only a
   * required authenticated profile (an enabled Steel SessionAuth snapshot) must
   * fail closed on mismatch — that is the H-07 guarantee: never silently run on
   * the wrong (or no) auth profile. Providers that manage their own profiles
   * (Kernel) record a best-effort continuation binding on recreate and, because
   * their create response does not reliably echo the loaded profile id,
   * legitimately report a different/NONE id; those must NOT fail closed.
   */
  required: boolean;
}

// Steel SessionAuth snapshots are the only profiles the agent MUST load exactly;
// their recorded source is steel_session_auth[/_read_only]. Every other source
// (Kernel/Steel user-persistent, benchmark-anon, disabled, etc.) is a
// best-effort continuation binding that tolerates a differing/NONE loaded id.
export function providerProfileBindingIsRequired(profileSource: string): boolean {
  return profileSource.startsWith('steel_session_auth');
}

export function recordedProviderProfileBinding(session: {
  providerProfileId?: string | null;
  providerProfileSource?: string | null;
}): ProviderProfileBinding | undefined {
  if (typeof session.providerProfileId !== 'string' || session.providerProfileId === '') {
    return undefined;
  }
  const profileSource = session.providerProfileSource ?? 'session_bound';
  return {
    profileId: session.providerProfileId,
    profileSource,
    required: providerProfileBindingIsRequired(profileSource),
  };
}

export function providerProfileMismatch(
  binding: ProviderProfileBinding | undefined,
  actualProfileId: string | null
): string | null {
  // Only a required authenticated profile fails closed on mismatch (H-07).
  // A best-effort binding (e.g. a Kernel-managed profile on recreate) may report
  // a different/NONE loaded id without that being fatal.
  if (binding === undefined || !binding.required || actualProfileId === binding.profileId) {
    return null;
  }
  return `loaded profile ${actualProfileId ?? 'NONE'} instead of bound profile ${binding.profileId}`;
}

export function providerProfileData(
  profileId: string | null,
  profileSource: string,
  persistProfile: boolean
) {
  return {
    providerProfileId: profileId,
    providerProfileSource: profileSource,
    providerProfilePersist: persistProfile,
  };
}
