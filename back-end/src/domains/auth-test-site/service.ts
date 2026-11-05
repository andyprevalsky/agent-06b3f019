import { resolvePlanContext } from './servicePlanContext';
import { randomBytes, timingSafeEqual } from '../../providers/crypto';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { getAuthOptions } from '../../providers/authOptions';
import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import * as sites from './repoSites';
import { AUTH_TEST_SITE_BASE_PATH, AUTH_TEST_SITE_REALM_PREFIX, fixtureApiKey } from './config';
import { buildFixtureManifest } from './serviceManifest';
import { planScenario, type PlanContext, type ScenarioPlan } from './serviceScenarios';
import { seedMintedLogin, seedPasskey, seedSavedPasswords, seedSavedSession } from './serviceSeed';
import { recordAttempt } from './serviceSignIn';
import {
  AuthTestSiteError,
  type AuthOptionsPreview,
  type AuthTestSite,
  type AuthTestSiteManifest,
  type AuthTestSiteReport,
  type CreateAuthTestSiteInput,
} from './types';

const log = createLogger('AuthTestSite');

export function isFixtureApiKey(candidate: string | undefined): boolean {
  const expected = fixtureApiKey();
  if (expected === '' || candidate === undefined || candidate === '') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function findSite(siteId: string): AuthTestSite | null {
  return sites.getSite(siteId);
}

export function siteUrl(site: AuthTestSite, suffix = '/'): string {
  return `${AUTH_TEST_SITE_BASE_PATH}/${site.siteId}${suffix}?authRealm=${encodeURIComponent(site.realm)}`;
}

/** The same page as an absolute public URL, for links that leave the browser (emails). */
export function publicSiteUrl(site: AuthTestSite, suffix: string): string {
  const base = site.entryUrl.slice(0, site.entryUrl.indexOf(AUTH_TEST_SITE_BASE_PATH));
  return `${base}${siteUrl(site, suffix)}`;
}

function normalizePublicBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new AuthTestSiteError('publicBaseUrl must be an absolute http(s) URL', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AuthTestSiteError('publicBaseUrl must be an absolute http(s) URL', 400);
  }
  return parsed;
}

async function previewAuthOptions(site: AuthTestSite): Promise<AuthOptionsPreview> {
  if (site.scenario === 'phone_sms_otp')
    return {
      passwordUsernames: [],
      mintedEmail: null,
      passkeyCount: 0,
      cookieBundleCount: 0,
      emailOtpInboxes: [],
    };
  const options = await getAuthOptions(site.userId, site.realm);
  return {
    passwordUsernames: options.passwords
      .filter((password) => !password.disabled)
      .map((password) => password.username),
    mintedEmail: options.minted?.email ?? null,
    passkeyCount: options.passkeys.filter((passkey) => !passkey.disabled).length,
    cookieBundleCount: options.cookie_bundles.filter((bundle) => !bundle.disabled).length,
    emailOtpInboxes: options.email_otp.available ? options.email_otp.connected_emails : [],
  };
}

/** A site with its scenario's accounts and behavior, before any credential is seeded. */
function newSite(
  input: CreateAuthTestSiteInput,
  plan: ScenarioPlan,
  ctx: PlanContext,
  where: { realm: string; entryUrl: string; publicOrigin: string; nowMs: number }
): AuthTestSite {
  return {
    siteId: ctx.siteId,
    scenario: input.scenario,
    behavior: plan.behavior,
    userId: input.userId,
    realm: where.realm,
    entryUrl: where.entryUrl,
    publicOrigin: where.publicOrigin,
    createdAtMs: where.nowMs,
    holderName: ctx.holderName,
    signInEmail: plan.expectedSignInEmail,
    ladder: plan.ladder === null ? null : { ...plan.ladder, served: [] },
    accounts: plan.accounts,
    savedPasswords: [],
    mintedEmail: ctx.mintedEmail,
    mintedPhone: ctx.mintedPhone,
    connectedInbox: ctx.connectedInbox,
    passkeyRowId: null,
    savedSessionBundleId: null,
    passkey: null,
    passkeyChallenges: [],
    staleSessionTokens: [],
    staleSessionSeen: false,
    savedSessionEmail: null,
    attempts: [],
    sessions: [],
    codes: [],
    appApprovalDeviceKey:
      plan.behavior.secondFactor === 'app_approval' ? randomBytes(32).toString('base64url') : null,
    appApprovalNumber: String(10 + (randomBytes(1)[0] % 90)),
    appApprovals: [],
    linkTokens: [],
    carts: {},
    guestCartTokens: [],
    orders: [],
    sessionExpiredAtOrder: false,
    lastPagePath: null,
  };
}

export async function createAuthTestSite(
  input: CreateAuthTestSiteInput
): Promise<AuthTestSiteManifest> {
  const user = await repo.findUserName(input.userId);
  if (user === null) {
    throw new AuthTestSiteError('User not found', 404);
  }
  const trimmedName = user.name?.trim() ?? '';
  const holderName = trimmedName === '' ? null : trimmedName;
  const nowMs = Date.now();
  const siteId = randomBytes(6).toString('hex');
  const realm = `${AUTH_TEST_SITE_REALM_PREFIX}${siteId}`;
  const publicBase = normalizePublicBaseUrl(input.publicBaseUrl);
  const entryUrl = `${publicBase.origin}${publicBase.pathname.replace(/\/+$/, '')}${AUTH_TEST_SITE_BASE_PATH}/${siteId}/?authRealm=${realm}`;
  if (canonicalAuthRealm(entryUrl) !== realm) {
    throw new AuthTestSiteError(
      `publicBaseUrl host does not honor ?authRealm= overrides: ${input.publicBaseUrl}`,
      400
    );
  }

  let site: AuthTestSite;
  let plan: ScenarioPlan;
  let preview: AuthOptionsPreview;
  try {
    const ctx = await resolvePlanContext(input, siteId, realm, holderName);
    plan = planScenario(input.scenario, ctx);
    site = newSite(input, plan, ctx, {
      realm,
      entryUrl,
      publicOrigin: publicBase.origin,
      nowMs,
    });
    site.savedPasswords = [
      ...(await seedSavedPasswords(site, plan, nowMs)),
      ...(await seedMintedLogin(site, plan, nowMs)),
    ];
    await seedSavedSession(site, plan, nowMs);
    await seedPasskey(site, plan);
    preview = await previewAuthOptions(site);
  } catch (error) {
    // The caller never learns this siteId, so nothing else can tear down the
    // rows already seeded for it — a leaked fixture inbox would change the auth
    // options of every later run for this benchmark user.
    await repo.deleteFixtureRows(input.userId, siteId).catch((cleanupError: unknown) => {
      log.error('Failed to remove the rows of a fixture that did not finish', {
        site_id: siteId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    });
    throw error;
  }
  if (site.mintedEmail === null) site.mintedEmail = preview.mintedEmail?.toLowerCase() ?? null;

  sites.putSite(site);
  log.info('Created auth test site', {
    site_id: siteId,
    scenario: input.scenario,
    user_id: input.userId,
    realm,
    saved_passwords: site.savedPasswords.length,
    saved_session: plan.savedSession?.state ?? null,
    passkey: site.passkey !== null,
    minted_email: site.mintedEmail,
  });

  return buildFixtureManifest(
    site,
    plan,
    preview,
    benchmarkSavedBrowserAuthDisabled(),
    site.appApprovalDeviceKey === null
      ? null
      : `${publicSiteUrl(site, '/device/approve')}&key=${site.appApprovalDeviceKey}`
  );
}

function requireSite(siteId: string): AuthTestSite {
  const site = sites.getSite(siteId);
  if (site === null) throw new AuthTestSiteError('Auth test site not found', 404);
  return site;
}

/** Marks a boundary in the attempt log, e.g. between two agent runs against one site. */
export function markRun(siteId: string, label: string): void {
  recordAttempt(requireSite(siteId), 'run_marker', label, 'started', null);
}

export async function buildReport(siteId: string): Promise<AuthTestSiteReport> {
  const site = requireSite(siteId);
  const [states, passkey, bundle] = await Promise.all([
    repo.findSavedPasswordStates(site.savedPasswords.map((record) => record.id)),
    repo.findPasskeyState(site.passkeyRowId),
    repo.findSavedSessionState(site.savedSessionBundleId),
  ]);
  const stateById = new Map(states.map((state) => [state.id, state]));
  return {
    siteId: site.siteId,
    scenario: site.scenario,
    realm: site.realm,
    entryUrl: site.entryUrl,
    createdAt: new Date(site.createdAtMs).toISOString(),
    ...(site.scenario === 'phone_sms_otp'
      ? {
          phoneSmsChallenges: site.codes.flatMap((c) =>
            c.phoneChallenge ? [{ ...c.phoneChallenge }] : []
          ),
        }
      : {}),
    mintedEmail: site.mintedEmail,
    mintedPhone: site.mintedPhone,
    signInEmail: site.signInEmail,
    savedPasswords: site.savedPasswords.map((record) => {
      const state = stateById.get(record.id);
      return {
        ...record,
        disabledAt: state?.disabledAt?.toISOString() ?? null,
        disabledReason: state?.disabledReason ?? null,
      };
    }),
    passkey:
      passkey === null
        ? null
        : {
            disabledAt: passkey.disabledAt?.toISOString() ?? null,
            signCount: Number(passkey.signCount),
          },
    savedSessionBundle:
      bundle === null ? null : { disabledAt: bundle.disabledAt?.toISOString() ?? null },
    accounts: site.accounts.map(({ email, memberNumber, origin, verified }) => ({
      email,
      memberNumber,
      origin,
      verified,
    })),
    attempts: [...site.attempts],
    sessions: site.sessions.map(({ email, method, createdAt, endedAt }) => ({
      email,
      method,
      createdAt,
      endedAt,
    })),
    orders: site.orders.map(({ lines, ...order }) => ({
      ...order,
      itemIds: lines.map((line) => line.id),
    })),
    lastPagePath: site.lastPagePath,
  };
}

/**
 * `userId` lets a caller tear down a site this process no longer holds (evicted,
 * expired, or created before a restart); without it an unknown site is a 404.
 */
export async function deleteAuthTestSite(siteId: string, userId: string | null = null) {
  const site = sites.getSite(siteId);
  if (site === null && userId === null) {
    throw new AuthTestSiteError('Auth test site not found', 404);
  }
  if (site !== null && userId !== null && site.userId !== userId) {
    throw new AuthTestSiteError('Auth test site belongs to another user', 403);
  }
  const deleted = await repo.deleteFixtureRows(site?.userId ?? (userId as string), siteId);
  sites.deleteSite(siteId);
  log.info('Deleted auth test site', { site_id: siteId, in_memory: site !== null, ...deleted });
  return { siteId, deleted };
}
