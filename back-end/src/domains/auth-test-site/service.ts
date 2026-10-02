import { randomBytes, timingSafeEqual } from '../../providers/crypto';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { getAuthOptions } from '../../providers/authOptions';
import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import * as sites from './repoSites';
import { AUTH_TEST_SITE_BASE_PATH, fixtureApiKey } from './config';
import {
  NEEDS_MINTED_IDENTITY,
  planScenario,
  type PlanContext,
  type ScenarioPlan,
} from './serviceScenarios';
import { seedPasskey, seedSavedPasswords, seedSavedSession } from './serviceSeed';
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

/** Resolves the identities a scenario's accounts live under, before anything is seeded. */
async function resolvePlanContext(
  input: CreateAuthTestSiteInput,
  siteId: string,
  realm: string,
  holderName: string | null
): Promise<PlanContext> {
  const ctx: PlanContext = {
    siteId,
    holderName,
    mintedEmail: null,
    mintedPhone: null,
    connectedInbox: null,
  };
  if (NEEDS_MINTED_IDENTITY.includes(input.scenario)) {
    const minted = (await getAuthOptions(input.userId, realm)).minted;
    if (minted === null) {
      throw new AuthTestSiteError(
        'No minted account is available for this user; is PRIMITIVE_API_KEY configured?',
        503
      );
    }
    ctx.mintedEmail = minted.email.toLowerCase();
    ctx.mintedPhone = minted.phone;
    if (input.scenario === 'minted_sms_otp' && minted.phone === null) {
      throw new AuthTestSiteError('The minted identity has no phone number to text', 503);
    }
  }
  if (input.scenario === 'email_otp') {
    const inbox = await repo.findConnectedInbox(input.userId);
    if (inbox === null) {
      throw new AuthTestSiteError('The user has no connected inbox to receive a code', 503);
    }
    ctx.connectedInbox = inbox.toLowerCase();
  }
  return ctx;
}

async function previewAuthOptions(site: AuthTestSite): Promise<AuthOptionsPreview> {
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
  const realm = `rose-shop-${siteId}.test`;
  const publicBase = normalizePublicBaseUrl(input.publicBaseUrl);
  const entryUrl = `${publicBase.origin}${publicBase.pathname.replace(/\/+$/, '')}${AUTH_TEST_SITE_BASE_PATH}/${siteId}/?authRealm=${realm}`;
  if (canonicalAuthRealm(entryUrl) !== realm) {
    throw new AuthTestSiteError(
      `publicBaseUrl host does not honor ?authRealm= overrides: ${input.publicBaseUrl}`,
      400
    );
  }

  const ctx = await resolvePlanContext(input, siteId, realm, holderName);
  const plan = planScenario(input.scenario, ctx);
  const site = newSite(input, plan, ctx, {
    realm,
    entryUrl,
    publicOrigin: publicBase.origin,
    nowMs,
  });
  site.savedPasswords = await seedSavedPasswords(site, plan, nowMs);
  await seedSavedSession(site, plan, nowMs);
  await seedPasskey(site, plan);
  const preview = await previewAuthOptions(site);
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

  return {
    siteId,
    scenario: input.scenario,
    realm,
    entryUrl,
    savedPasswordUsernames: site.savedPasswords.map((record) => record.username),
    mintedEmail: site.mintedEmail,
    mintedPhone: site.mintedPhone,
    expectedSignInEmail: plan.expectedSignInEmail,
    expectedMemberNumber: plan.expectedMemberNumber,
    namedAccountEmail: plan.namedAccountEmail,
    userSignIn: plan.userSignIn,
    savedSession: plan.savedSession?.state ?? null,
    savedBrowserAuthHidden: benchmarkSavedBrowserAuthDisabled(),
    authOptionsPreview: preview,
  };
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

export async function deleteAuthTestSite(siteId: string) {
  const site = requireSite(siteId);
  const deleted = await repo.deleteFixtureCredentials({
    userId: site.userId,
    sitePath: `${AUTH_TEST_SITE_BASE_PATH}/${site.siteId}/`,
    realm: site.realm,
    siteId: site.siteId,
  });
  sites.deleteSite(siteId);
  log.info('Deleted auth test site', { site_id: siteId, ...deleted });
  return { siteId, deleted };
}
