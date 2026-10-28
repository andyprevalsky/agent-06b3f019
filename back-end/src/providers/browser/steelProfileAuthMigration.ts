/**
 * Browser sign-ins are shared across providers (issue T82).
 *
 * A SteelSessionAuth binds a user's sign-in for one realm to an exact Steel
 * profile. When the deployment's provider is not Steel, that sign-in must
 * still reach the new browser instead of forcing the run onto Steel:
 *
 *   SteelSessionAuth(realm → profile)          selected provider ≠ steel
 *     ├─ migrated bundle (source steel_profile_migration, newer than the auth) → done
 *     └─ else: short Steel session on the profile (read-only, persistProfile=false)
 *              → visit the realm → captureContextStorage (cookies, localStorage, IndexedDB)
 *              → release → persist into CookieBundle / LocalStorageOrigin / IndexedDBOrigin
 *   then the selected provider's session is created with the normal injectUserData.
 *
 * The SteelSessionAuth stays enabled, so a Steel-selected run is unchanged.
 * A harvest that yields no signed-in cookie for the realm is a typed failure:
 * the run never claims an authentication it cannot prove, and never silently
 * falls back to Steel.
 */
import { createHash } from 'node:crypto';
import type { Browser } from 'playwright';
import { canonicalAuthRealm } from '../authRealm';
import { benchmarkSavedBrowserAuthDisabled } from '../benchmarkBrowserAuth';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { releaseSteelRemoteSession, steel } from '../steel/session';
import {
  newOwnedSteelSessionId,
  registerInFlightSteelSession,
  unregisterInFlightSteelSession,
} from '../steel/sessionIdentity';
import { steelCdpConnectionUrl, steelCdpUrl } from '../steel/urls';
import { captureContextStorage } from './contextStorageCapture';
import {
  CLOUD_PERSISTENT_BROWSER_PROFILE,
  persistHarvestedCookies,
  persistHarvestedLocalStorage,
  type HarvestBudget,
} from './sessionAuthPersist';
import type { StorageState } from './tilionState';
import type { BrowserProviderName } from './types';

const log = createLogger('SteelProfileAuthMigration');

/** CookieBundle.browserSource of state migrated out of a Steel profile. */
export const STEEL_PROFILE_MIGRATION_SOURCE = 'steel_profile_migration';
const HARVEST_TIMEOUT_MS = 60_000;
const PERSIST_BUDGET_MS = 20_000;

export class SteelProfileAuthMigrationError extends Error {
  constructor(
    readonly authRealm: string,
    readonly steelProfileId: string,
    reason: string
  ) {
    super(
      `Saved ${authRealm} sign-in could not be moved off Steel profile ${steelProfileId}: ${reason}`
    );
    this.name = 'SteelProfileAuthMigrationError';
  }
}

export interface SteelSignInBinding {
  id: string;
  contextId: string;
  authRealm: string;
  authenticatedAt: Date;
}

export interface SteelProfileAuthMigrationDependencies {
  findBinding: (userId: string, authRealm: string) => Promise<SteelSignInBinding | null>;
  findMigratedAt: (userId: string, authRealm: string) => Promise<Date | null>;
  harvestProfile: (steelProfileId: string, authRealm: string) => Promise<StorageState>;
  persistState: (
    userId: string,
    authRealm: string,
    state: StorageState
  ) => Promise<{ cookieCount: number; realmCount: number; originCount: number }>;
}

export type SteelProfileAuthShareResult =
  | { status: 'not_needed' }
  | { status: 'already_migrated'; authRealm: string }
  | { status: 'migrated'; authRealm: string; cookieCount: number; originCount: number };

async function findBinding(userId: string, authRealm: string): Promise<SteelSignInBinding | null> {
  return prisma.steelSessionAuth.findFirst({
    where: { userId, authRealm, disabledAt: null },
    orderBy: { authenticatedAt: 'desc' },
    select: { id: true, contextId: true, authRealm: true, authenticatedAt: true },
  });
}

async function findMigratedAt(userId: string, authRealm: string): Promise<Date | null> {
  const bundle = await prisma.cookieBundle.findFirst({
    where: {
      userId,
      authRealm,
      browserSource: STEEL_PROFILE_MIGRATION_SOURCE,
      browserProfile: CLOUD_PERSISTENT_BROWSER_PROFILE,
      disabledAt: null,
    },
    select: { updatedAt: true },
  });
  return bundle?.updatedAt ?? null;
}

/** A short read-only Steel session on the bound profile; always released. */
async function harvestSteelProfile(
  steelProfileId: string,
  authRealm: string
): Promise<StorageState> {
  const session = await steel.sessions.create({
    sessionId: newOwnedSteelSessionId(),
    profileId: steelProfileId,
    persistProfile: false,
    solveCaptcha: false,
    timeout: 5 * 60_000,
  });
  registerInFlightSteelSession(session.id);
  let browser: Browser | null = null;
  try {
    if (session.profileId !== steelProfileId) {
      throw new SteelProfileAuthMigrationError(
        authRealm,
        steelProfileId,
        `Steel loaded profile ${session.profileId ?? 'NONE'}`
      );
    }
    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP(steelCdpConnectionUrl(steelCdpUrl(session.id)), {
      timeout: HARVEST_TIMEOUT_MS,
    });
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error('Steel session has no browser context');
    const page = context.pages()[0] ?? (await context.newPage());
    // localStorage and IndexedDB are per origin: open the realm so they load.
    await page
      .goto(`https://${authRealm}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch((error: unknown) =>
        log.warn('Realm page did not load during Steel profile harvest; cookies still read', {
          authRealm,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    return await captureContextStorage(context);
  } finally {
    await browser?.close().catch(() => undefined);
    unregisterInFlightSteelSession(session.id);
    await releaseSteelRemoteSession(session.id);
  }
}

type CapturedDatabase = {
  name?: unknown;
  stores?: Array<{
    name?: unknown;
    keyPath?: unknown;
    records?: Array<{ key?: unknown; value?: unknown }>;
  }>;
};

/** Capture shape ({stores}) → the IndexedDBOrigin shape injectIndexedDBState restores ({objectStores}). */
export function indexedDbForInjection(databases: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(databases)) return [];
  return (databases as CapturedDatabase[]).flatMap((database) =>
    typeof database.name !== 'string'
      ? []
      : [
          {
            name: database.name,
            objectStores: (database.stores ?? []).flatMap((store) =>
              typeof store.name !== 'string'
                ? []
                : [
                    {
                      name: store.name,
                      records: (store.records ?? []).map((record) => ({
                        key:
                          record.key !== undefined
                            ? record.key
                            : typeof store.keyPath === 'string' &&
                                record.value !== null &&
                                typeof record.value === 'object'
                              ? (record.value as Record<string, unknown>)[store.keyPath]
                              : undefined,
                        value: record.value,
                      })),
                    },
                  ]
            ),
          },
        ]
  );
}

function inRealm(origin: string, authRealm: string): boolean {
  return canonicalAuthRealm(origin) === authRealm;
}

async function persistMigratedState(
  userId: string,
  authRealm: string,
  state: StorageState
): Promise<{ cookieCount: number; realmCount: number; originCount: number }> {
  const deadline = Date.now() + PERSIST_BUDGET_MS;
  const budget: HarvestBudget = {
    remainingMs: () => Math.max(1, deadline - Date.now()),
    spent: () => Date.now() >= deadline,
  };
  const cookies = await persistHarvestedCookies(
    userId,
    STEEL_PROFILE_MIGRATION_SOURCE,
    state.cookies,
    new Set([authRealm]),
    budget
  );
  // No signed-in cookie: write nothing else (the caller fails the migration).
  if (cookies.realmCount === 0) return { cookieCount: 0, realmCount: 0, originCount: 0 };
  const origins = state.origins.filter((origin) => inRealm(origin.origin, authRealm));
  const storage = await persistHarvestedLocalStorage(userId, origins, budget);
  let indexedDbOrigins = 0;
  for (const origin of origins) {
    const databases = indexedDbForInjection((origin as { indexedDB?: unknown }).indexedDB);
    if (databases.length === 0) continue;
    const hash = createHash('sha256').update(JSON.stringify(databases)).digest('hex');
    await prisma.indexedDBOrigin.upsert({
      where: { userId_origin: { userId, origin: origin.origin } },
      create: { userId, origin: origin.origin, databases: databases as object[], hash },
      update: { databases: databases as object[], hash },
    });
    indexedDbOrigins += 1;
  }
  return {
    cookieCount: cookies.cookieCount,
    realmCount: cookies.realmCount,
    originCount: Math.max(storage.written, indexedDbOrigins),
  };
}

const defaultDependencies: SteelProfileAuthMigrationDependencies = {
  findBinding,
  findMigratedAt,
  harvestProfile: harvestSteelProfile,
  persistState: persistMigratedState,
};

/**
 * Make a Steel-profile-bound sign-in available to `selectedProvider`. No-op for
 * Steel itself, for realms without a binding, and once the binding is migrated.
 */
export async function shareSteelProfileSignIn(
  userId: string,
  startUrl: string,
  selectedProvider: BrowserProviderName,
  dependencies: SteelProfileAuthMigrationDependencies = defaultDependencies
): Promise<SteelProfileAuthShareResult> {
  const authRealm = canonicalAuthRealm(startUrl);
  if (selectedProvider === 'steel' || authRealm === '' || benchmarkSavedBrowserAuthDisabled()) {
    return { status: 'not_needed' };
  }
  const binding = await dependencies.findBinding(userId, authRealm);
  if (binding === null) return { status: 'not_needed' };
  const migratedAt = await dependencies.findMigratedAt(userId, authRealm);
  if (migratedAt !== null && migratedAt >= binding.authenticatedAt) {
    return { status: 'already_migrated', authRealm };
  }
  let state: StorageState;
  try {
    state = await dependencies.harvestProfile(binding.contextId, authRealm);
  } catch (error) {
    log.error('Steel profile sign-in harvest failed', {
      userId,
      authRealm,
      steelProfileId: binding.contextId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof SteelProfileAuthMigrationError) throw error;
    throw new SteelProfileAuthMigrationError(
      authRealm,
      binding.contextId,
      error instanceof Error ? error.message : String(error)
    );
  }
  const persisted = await dependencies.persistState(userId, authRealm, state);
  if (persisted.realmCount === 0) {
    log.error('Steel profile held no signed-in cookie for the realm', {
      userId,
      authRealm,
      steelProfileId: binding.contextId,
      harvestedCookies: state.cookies.length,
    });
    throw new SteelProfileAuthMigrationError(
      authRealm,
      binding.contextId,
      'the profile holds no signed-in cookie for this realm'
    );
  }
  log.info('Steel profile sign-in shared with the selected provider', {
    userId,
    authRealm,
    selectedProvider,
    steelProfileId: binding.contextId,
    cookieCount: persisted.cookieCount,
    originCount: persisted.originCount,
  });
  return {
    status: 'migrated',
    authRealm,
    cookieCount: persisted.cookieCount,
    originCount: persisted.originCount,
  };
}
