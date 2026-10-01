/**
 * Scenario seeds. Each scenario is only a set of site accounts plus the saved
 * passwords the user "has" for the site — nothing in it tells the agent what to
 * do. Saved passwords are ordered by recency, so the agent sees them freshest
 * first, exactly like a synced browser keychain.
 *
 *   password_retry  #1 stale password for a real account (1d ago)
 *                   #2 account that does not exist on this site (10d ago)
 *                   #3 correct password (30d ago)            -> sign in as #3
 *   all_fail        #1 stale password, #2 unknown account, #3 stale password
 *                   -> no saved credential works; no minted account is offered
 *   minted_otp      no saved passwords; the site account belongs to the agent's
 *                   minted inbox and only supports emailed sign-in codes
 */

import { randomBytes } from '../../providers/crypto';
import type { AuthTestSiteScenario, SavedPasswordSeed, SiteAccount } from './types';

export interface ScenarioPlan {
  accounts: SiteAccount[];
  savedPasswords: SavedPasswordSeed[];
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

function siteEmail(localPart: string, siteId: string): string {
  return `${localPart}.${siteId}@example.com`;
}

function passwordRetryPlan(siteId: string): ScenarioPlan {
  const primary = siteEmail('jordan.ellis', siteId);
  const unknown = siteEmail('jordan.e', siteId);
  const working = siteEmail('j.ellis', siteId);
  const workingPassword = randomPassword();
  const workingMember = randomMemberNumber();
  return {
    accounts: [
      { email: primary, password: randomPassword(), memberNumber: randomMemberNumber() },
      { email: working, password: workingPassword, memberNumber: workingMember },
    ],
    savedPasswords: [
      { username: primary, password: randomPassword(), lastUsedDaysAgo: 1 },
      { username: unknown, password: randomPassword(), lastUsedDaysAgo: 10 },
      { username: working, password: workingPassword, lastUsedDaysAgo: 30 },
    ],
    usesMintedAccount: false,
    expectedSignInEmail: working,
    expectedMemberNumber: workingMember,
  };
}

function allFailPlan(siteId: string): ScenarioPlan {
  const primary = siteEmail('jordan.ellis', siteId);
  const unknown = siteEmail('jordan.e', siteId);
  const secondary = siteEmail('j.ellis', siteId);
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
    usesMintedAccount: false,
    expectedSignInEmail: null,
    expectedMemberNumber: null,
  };
}

function mintedOtpPlan(): ScenarioPlan {
  return {
    accounts: [],
    savedPasswords: [],
    usesMintedAccount: true,
    expectedSignInEmail: null,
    expectedMemberNumber: randomMemberNumber(),
  };
}

export function planScenario(scenario: AuthTestSiteScenario, siteId: string): ScenarioPlan {
  switch (scenario) {
    case 'password_retry':
      return passwordRetryPlan(siteId);
    case 'all_fail':
      return allFailPlan(siteId);
    case 'minted_otp':
      return mintedOtpPlan();
  }
}
