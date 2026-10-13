/** Fixture accounting only: every side effect is injected for native-free regression tests. */
export interface AuthPersistAllocation {
  sessionId: string;
  provider: string;
  profileId?: string;
}

export interface AuthPersistCustody {
  identity: {
    phoneProvider: string | null;
    phoneProviderAgentId: string | null;
    phoneProviderNumberId: string | null;
  } | null;
  sessions: Array<{ sessionId: string; provider: string; providerProfileId: string | null }>;
  profiles: Array<{ provider: string; profileId: string }>;
}

export interface AuthPersistCleanupResult {
  kind: string;
  id: string;
  succeeded: boolean;
}

export async function cleanupAuthPersistFixture(options: {
  userId: string;
  userCreated: boolean;
  initUnresolved: boolean;
  allocated: AuthPersistAllocation[];
  originalFailure?: unknown;
  journalPath: string;
  snapshot: () => Promise<AuthPersistCustody>;
  saveJournal: (
    phase: string,
    custody: AuthPersistCustody | undefined,
    results: AuthPersistCleanupResult[],
    ownerRetained: boolean
  ) => Promise<void>;
  releaseBrowser: (session: AuthPersistAllocation) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  cleanupLocal: (deleteUser: boolean) => Promise<void>;
}): Promise<void> {
  const errors: unknown[] = [];
  const results: AuthPersistCleanupResult[] = [];
  let custody: AuthPersistCustody | undefined;
  let ownerRetained = true;
  const save = (phase: string) => options.saveJournal(phase, custody, results, ownerRetained);
  const attempt = async (kind: string, id: string, action: () => Promise<void>) => {
    try {
      await action();
      results.push({ kind, id, succeeded: true });
    } catch {
      results.push({ kind, id, succeeded: false });
      errors.push(new Error(`Auth persist cleanup failed: ${kind} ${id}`));
    }
  };
  try {
    // A rejected/unknown create never grants ownership of a same-ID preexisting user.
    if (!options.userCreated) {
      await save('setup-ownership-unconfirmed');
      return;
    }
    custody = await options.snapshot();
    // This durable checkpoint must precede any native or local destructive operation.
    await save('before-cleanup');
    const sessions = new Map(options.allocated.map((session) => [session.sessionId, session]));
    for (const session of custody.sessions) sessions.set(session.sessionId, session);
    for (const session of sessions.values()) {
      await attempt('browser', session.sessionId, () => options.releaseBrowser(session));
      await save('releasing-browsers');
    }
    const profiles = new Set(
      custody.profiles.filter((p) => p.provider === 'kernel').map((p) => p.profileId)
    );
    for (const session of options.allocated) {
      if (session.provider === 'kernel' && session.profileId) profiles.add(session.profileId);
    }
    for (const session of custody.sessions) {
      if (session.provider === 'kernel' && session.providerProfileId)
        profiles.add(session.providerProfileId);
    }
    // A browser-release failure retains profiles and local ownership bindings.
    if (errors.length === 0) {
      for (const profileId of profiles) {
        await attempt('kernel-profile', profileId, () => options.deleteProfile(profileId));
        await save('releasing-profiles');
      }
    }
    if (errors.length === 0) {
      const identity = custody.identity;
      const hasPhoneCustody =
        identity !== null &&
        (identity.phoneProvider !== null ||
          identity.phoneProviderAgentId !== null ||
          identity.phoneProviderNumberId !== null);
      const deleteUser = !options.initUnresolved && !hasPhoneCustody;
      await attempt('local-browser-fixture', options.userId, async () => {
        await options.cleanupLocal(deleteUser);
        ownerRetained = !deleteUser;
      });
    }
    await save(
      errors.length
        ? 'cleanup-failed-retained'
        : ownerRetained
          ? 'phone-custody-retained'
          : 'cleanup-complete'
    );
  } catch {
    // Journal/discovery errors stop further mutations; the preceding durable record remains.
    errors.push(
      new Error('Auth persist custody discovery or journal failed; inspect last custody checkpoint')
    );
  }
  if (errors.length) {
    throw new AggregateError(
      options.originalFailure === undefined ? errors : [options.originalFailure, ...errors],
      `Auth persist fixture cleanup failed; private custody: ${options.journalPath}`
    );
  }
}
