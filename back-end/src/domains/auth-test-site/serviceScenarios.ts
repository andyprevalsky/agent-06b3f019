/**
 * Scenario seeds. Each scenario is only a set of site accounts plus the saved
 * passwords the user "has" for the site — nothing in it tells the agent what to
 * do. Saved passwords are ordered by recency, so the agent sees them freshest
 * first, exactly like a synced browser keychain. Every saved login is an
 * address derived from the user's own name (Avery Ross → avery.ross, averyr,
 * a.ross), as a real person's keychain would hold.
 *
 *   password_retry  three saved logins (1d, 10d, 30d ago); whichever two
 *                   distinct ones the agent submits first fail (stale
 *                   password, then unknown account) and the third signs in,
 *                   so two failures precede success in any order
 *   all_fail        #1 stale password, #2 unknown account, #3 stale password
 *                   -> no saved credential works; no minted account is offered
 *   minted_otp      no saved passwords; the site account belongs to the agent's
 *                   minted inbox and only supports emailed sign-in codes
 */

import { randomBytes } from '../../providers/crypto';
import type {
  AuthTestSiteScenario,
  SavedLoginLadder,
  SavedPasswordSeed,
  SiteAccount,
} from './types';

export interface ScenarioPlan {
  accounts: SiteAccount[];
  savedPasswords: SavedPasswordSeed[];
  ladder: Omit<SavedLoginLadder, 'served'> | null;
  usesMintedAccount: boolean;
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
}

export function randomMemberNumber(): string {
  const value = (randomBytes(4).readUInt32BE(0) % 90_000_000) + 10_000_000;
  return `LM-${value}`;
}

function randomPassword(): string {
  return `${randomBytes(9).toString('base64url')}#7a`;
}

function nameTokens(holderName: string | null): string[] {
  return (holderName ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

/** Three distinct name-derived logins: freshest-first slots #1, #2, #3. */
function savedLoginEmails(holderName: string | null, siteId: string): [string, string, string] {
  const tokens = nameTokens(holderName);
  const first = tokens[0] ?? 'member';
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : 'larkspur';
  const candidates = [
    `${first}.${last}`,
    `${first}${last.charAt(0)}`,
    `${first.charAt(0)}.${last}`,
    `${last}.${first}`,
    `${first}.${last}2`,
  ];
  const [a, b, c] = [...new Set(candidates)].map((local) => `${local}.${siteId}@example.com`);
  return [a, b, c];
}

const SAVED_LOGIN_AGES_DAYS = [1, 10, 30];

function passwordRetryPlan(siteId: string, holderName: string | null): ScenarioPlan {
  const logins = savedLoginEmails(holderName, siteId).map((email) => ({
    email,
    password: randomPassword(),
  }));
  const memberNumber = randomMemberNumber();
  return {
    accounts: [],
    savedPasswords: logins.map((login, index) => ({
      username: login.email,
      password: login.password,
      lastUsedDaysAgo: SAVED_LOGIN_AGES_DAYS[index] ?? 30,
    })),
    ladder: { logins, rejections: ['wrong_password', 'unknown_account'], memberNumber },
    usesMintedAccount: false,
    expectedSignInEmail: null,
    expectedMemberNumber: memberNumber,
  };
}

function allFailPlan(siteId: string, holderName: string | null): ScenarioPlan {
  const [primary, unknown, secondary] = savedLoginEmails(holderName, siteId);
  return {
    accounts: [
      { email: primary, password: randomPassword(), memberNumber: randomMemberNumber() },
      { email: secondary, password: randomPassword(), memberNumber: randomMemberNumber() },
    ],
    savedPasswords: [
      { username: primary, password: randomPassword(), lastUsedDaysAgo: 1 },
      { username: unknown, password: randomPassword(), lastUsedDaysAgo: 10 },
      { username: secondary, password: randomPassword(), lastUsedDaysAgo: 30 },
    ],
    ladder: null,
    usesMintedAccount: false,
    expectedSignInEmail: null,
    expectedMemberNumber: null,
  };
}

function mintedOtpPlan(): ScenarioPlan {
  return {
    accounts: [],
    savedPasswords: [],
    ladder: null,
    usesMintedAccount: true,
    expectedSignInEmail: null,
    expectedMemberNumber: randomMemberNumber(),
  };
}

export function planScenario(
  scenario: AuthTestSiteScenario,
  siteId: string,
  holderName: string | null
): ScenarioPlan {
  switch (scenario) {
    case 'password_retry':
      return passwordRetryPlan(siteId, holderName);
    case 'all_fail':
      return allFailPlan(siteId, holderName);
    case 'minted_otp':
      return mintedOtpPlan();
  }
}
