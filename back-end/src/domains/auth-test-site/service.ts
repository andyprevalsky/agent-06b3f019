import { randomBytes, timingSafeEqual } from '../../providers/crypto';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { getAuthOptions } from '../../providers/authOptions';
import { benchmarkSavedBrowserAuthDisabled } from '../../providers/benchmarkBrowserAuth';
import { encryptPasswordForStorage } from '../../providers/credentialEnvelope';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import * as sites from './repoSites';
import { AUTH_TEST_SITE_BASE_PATH, fixtureApiKey } from './config';
import { planScenario, randomMemberNumber, type ScenarioPlan } from './serviceScenarios';
import {
  AuthTestSiteError,
  type AuthTestSite,
  type AuthTestSiteManifest,
  type AuthTestSiteReport,
  type CreateAuthTestSiteInput,
  type SavedPasswordRecord,
  type SiteAccount,
} from './types';

const log = createLogger('AuthTestSite');
const DAY_MS = 24 * 60 * 60 * 1000;

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

function normalizePublicBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new AuthTestSiteError('publicBaseUrl must be an absolute http(s) URL', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AuthTestSiteError('publicBaseUrl must be an absolute http(s) URL', 400);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

async function seedSavedPasswords(
  userId: string,
  origin: string,
  plan: ScenarioPlan,
  nowMs: number
): Promise<SavedPasswordRecord[]> {
  const records: SavedPasswordRecord[] = [];
  for (const seed of plan.savedPasswords) {
    const id = await repo.upsertSavedPassword({
      userId,
      origin,
      username: seed.username,
      encryptedPassword: encryptPasswordForStorage(seed.password),
      dateLastUsedMs: nowMs - seed.lastUsedDaysAgo * DAY_MS,
    });
    const account = plan.accounts.find((candidate) => candidate.email === seed.username);
    records.push({
      id,
      username: seed.username,
      matchesAccount: account?.password === seed.password,
    });
  }
  return records;
}

function mintedAccounts(plan: ScenarioPlan, mintedEmail: string | null): SiteAccount[] {
  if (!plan.usesMintedAccount) return plan.accounts;
  if (mintedEmail === null) {
    throw new AuthTestSiteError(
      'No minted account is available for this user; is PRIMITIVE_API_KEY configured?',
      503
    );
  }
  const memberNumber = plan.expectedMemberNumber ?? randomMemberNumber();
  return [{ email: mintedEmail.toLowerCase(), password: null, memberNumber }];
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
  const realm = `larkspur-${siteId}.test`;
  const entryUrl = `${normalizePublicBaseUrl(input.publicBaseUrl)}${AUTH_TEST_SITE_BASE_PATH}/${siteId}/?authRealm=${realm}`;
  if (canonicalAuthRealm(entryUrl) !== realm) {
    throw new AuthTestSiteError(
      `publicBaseUrl host does not honor ?authRealm= overrides: ${input.publicBaseUrl}`,
      400
    );
  }

  const plan = planScenario(input.scenario, siteId, holderName);
  const savedPasswords = await seedSavedPasswords(input.userId, entryUrl, plan, nowMs);
  const authOptions = await getAuthOptions(input.userId, realm);
  const mintedEmail = authOptions.minted?.email ?? null;
  const accounts = mintedAccounts(plan, mintedEmail);
  const expectedSignInEmail = plan.usesMintedAccount
    ? (accounts[0]?.email ?? null)
    : plan.expectedSignInEmail;
  const expectedMemberNumber =
    plan.ladder?.memberNumber ??
    accounts.find((account) => account.email === expectedSignInEmail)?.memberNumber ??
    null;

  sites.putSite({
    siteId,
    scenario: input.scenario,
    userId: input.userId,
    realm,
    entryUrl,
    createdAtMs: nowMs,
    holderName,
    signInEmail: expectedSignInEmail,
    ladder: plan.ladder === null ? null : { ...plan.ladder, served: [] },
    accounts,
    savedPasswords,
    mintedEmail,
    attempts: [],
    sessions: [],
    codes: [],
  });
  log.info('Created auth test site', {
    site_id: siteId,
    scenario: input.scenario,
    user_id: input.userId,
    realm,
    saved_passwords: savedPasswords.length,
    minted_email: mintedEmail,
  });

  return {
    siteId,
    scenario: input.scenario,
    realm,
    entryUrl,
    savedPasswordUsernames: savedPasswords.map((record) => record.username),
    mintedEmail,
    expectedSignInEmail,
    expectedMemberNumber,
    savedBrowserAuthHidden: benchmarkSavedBrowserAuthDisabled(),
    authOptionsPreview: {
      passwordUsernames: authOptions.passwords
        .filter((password) => !password.disabled)
        .map((password) => password.username),
      mintedEmail,
    },
  };
}

function requireSite(siteId: string): AuthTestSite {
  const site = sites.getSite(siteId);
  if (site === null) throw new AuthTestSiteError('Auth test site not found', 404);
  return site;
}

export async function buildReport(siteId: string): Promise<AuthTestSiteReport> {
  const site = requireSite(siteId);
  const states = await repo.findSavedPasswordStates(site.savedPasswords.map((record) => record.id));
  const stateById = new Map(states.map((state) => [state.id, state]));
  return {
    siteId: site.siteId,
    scenario: site.scenario,
    realm: site.realm,
    entryUrl: site.entryUrl,
    createdAt: new Date(site.createdAtMs).toISOString(),
    mintedEmail: site.mintedEmail,
    signInEmail: site.signInEmail,
    savedPasswords: site.savedPasswords.map((record) => {
      const state = stateById.get(record.id);
      return {
        ...record,
        disabledAt: state?.disabledAt?.toISOString() ?? null,
        disabledReason: state?.disabledReason ?? null,
      };
    }),
    attempts: [...site.attempts],
    sessions: site.sessions.map(({ email, method, createdAt, endedAt }) => ({
      email,
      method,
      createdAt,
      endedAt,
    })),
  };
}

export async function deleteAuthTestSite(siteId: string) {
  const site = requireSite(siteId);
  const deleted = await repo.deleteFixtureCredentials({
    userId: site.userId,
    origin: site.entryUrl,
    realm: site.realm,
  });
  sites.deleteSite(siteId);
  log.info('Deleted auth test site', { site_id: siteId, ...deleted });
  return { siteId, deleted };
}
