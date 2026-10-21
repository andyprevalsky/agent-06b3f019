import { phoneSmsPlan } from './servicePhoneSmsPlan';
/**
 * Scenario seeds. Each scenario is only a set of site accounts, what the user
 * "has" saved for the site, and how the site behaves — nothing in it tells the
 * agent what to do. Saved passwords are ordered by recency, so the agent sees
 * them freshest first, exactly like a synced browser keychain. Every saved
 * login is an address derived from the user's own name (Avery Ross →
 * avery.ross, averyr, a.ross), as a real person's keychain would hold.
 *
 *   saved credentials            site behavior                       scenario
 *   ───────────────────────────  ──────────────────────────────────  ───────────────────────────
 *   3 logins, 3rd tried works    password form                       password_retry
 *   3 logins, none works         password form                       saved_logins_fail / user_signs_in
 *   expired session + rejected   every method fails                  all_fail
 *     passkey + 3 failing logins
 *   valid / expired session      password form                       saved_session / stale_session
 *   passkey + working login      email first, passkey ok / rejected  passkey / passkey_rejected
 *   login under agent's inbox    emailed code after the password     password_email_2fa
 *   1 login                      account locked                      account_locked
 *   2 logins, freshest stale     password form                       failed_login_not_reoffered
 *   2 working logins             password form                       named_account
 *   1 working login              shop; session ends at order         session_expires_at_checkout
 *   none (minted has account)    emailed code ok / never / expired   minted_otp / code_never_arrives / expired_code
 *   none (minted has account)    texted code / emailed link          minted_sms_otp / magic_link
 *   none (user's inbox account)  emailed code to the user's inbox    email_otp
 *   none                         sign-up ok / duplicate              signup / signup_already_registered
 *   none                         shop: guest ok / account required   guest_purchase / signup_purchase / signup_fails_purchase
 *   none                         sign-up, then password-only         created_account_reused
 */

import { randomBytes } from '../../providers/crypto';
import type {
  AuthTestSiteScenario,
  SavedLoginLadder,
  SavedPasswordSeed,
  SiteAccount,
  SiteBehavior,
} from './types';
import { BASE_BEHAVIOR, GUEST_SHOP, MEMBER_PRICE_SHOP, SHOP } from './serviceScenarioBehaviors';

export interface PlanContext {
  siteId: string;
  holderName: string | null;
  /** The agent's minted inbox / phone; null when the scenario does not need them resolved. */
  mintedEmail: string | null;
  mintedPhone: string | null;
  /** An inbox the user connected, whose codes the agent can read. */
  connectedInbox: string | null;
  ownedPhone?: string;
}

export type MintedUse = 'none' | 'offered' | 'account';

export interface ScenarioPlan {
  behavior: SiteBehavior;
  accounts: SiteAccount[];
  savedPasswords: SavedPasswordSeed[];
  ladder: Omit<SavedLoginLadder, 'served'> | null;
  /** offered: auth options list the minted identity; account: it also already has a site account. */
  minted: MintedUse;
  savedSession: { email: string; state: 'valid' | 'expired' } | null;
  passkeyEmail: string | null;
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
  namedAccountEmail: string | null;
  userSignIn: { email: string; password: string } | null;
}

/** Scenarios whose plan needs the minted identity resolved before anything is seeded. */
export const NEEDS_MINTED_IDENTITY: readonly AuthTestSiteScenario[] = [
  'minted_otp',
  'code_never_arrives',
  'expired_code',
  'minted_sms_otp',
  'magic_link',
  'signup_already_registered',
  'password_email_2fa',
];

export function randomMemberNumber(): string {
  const value = (randomBytes(4).readUInt32BE(0) % 90_000_000) + 10_000_000;
  return `RS-${value}`;
}

function randomPassword(): string {
  return `${randomBytes(9).toString('base64url')}#7a`;
}

function nameTokens(holderName: string | null): string[] {
  return (holderName ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
}

/** Three distinct name-derived logins: freshest-first slots #1, #2, #3. */
function savedLoginEmails(holderName: string | null, siteId: string): [string, string, string] {
  const tokens = nameTokens(holderName);
  const first = tokens[0] ?? 'member';
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : 'shopper';
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

function account(
  ctx: PlanContext,
  email: string,
  password: string | null,
  extra: Partial<SiteAccount> = {}
): SiteAccount {
  return {
    email: email.toLowerCase(),
    password,
    memberNumber: randomMemberNumber(),
    name: ctx.holderName,
    phone: null,
    locked: false,
    verified: true,
    origin: 'seed',
    ...extra,
  };
}

function plan(overrides: Partial<ScenarioPlan>): ScenarioPlan {
  return {
    behavior: BASE_BEHAVIOR,
    accounts: [],
    savedPasswords: [],
    ladder: null,
    minted: 'none',
    savedSession: null,
    passkeyEmail: null,
    expectedSignInEmail: null,
    expectedMemberNumber: null,
    namedAccountEmail: null,
    userSignIn: null,
    ...overrides,
  };
}

function passwordRetryPlan(ctx: PlanContext): ScenarioPlan {
  const logins = savedLoginEmails(ctx.holderName, ctx.siteId).map((email) => ({
    email,
    password: randomPassword(),
  }));
  const memberNumber = randomMemberNumber();
  return plan({
    savedPasswords: logins.map((login, index) => ({
      username: login.email,
      password: login.password,
      lastUsedDaysAgo: SAVED_LOGIN_AGES_DAYS[index] ?? 30,
    })),
    ladder: { logins, rejections: ['wrong_password', 'unknown_account'], memberNumber },
    expectedMemberNumber: memberNumber,
  });
}

/** #1 stale password, #2 unknown account, #3 stale password; the user knows #1's real password. */
function savedLoginsFailPlan(ctx: PlanContext, behavior: Partial<SiteBehavior> = {}): ScenarioPlan {
  const [primary, unknown, secondary] = savedLoginEmails(ctx.holderName, ctx.siteId);
  const realPassword = randomPassword();
  return plan({
    behavior: { ...BASE_BEHAVIOR, ...behavior },
    accounts: [account(ctx, primary, realPassword), account(ctx, secondary, randomPassword())],
    savedPasswords: [
      { username: primary, password: randomPassword(), lastUsedDaysAgo: 1 },
      { username: unknown, password: randomPassword(), lastUsedDaysAgo: 10 },
      { username: secondary, password: randomPassword(), lastUsedDaysAgo: 30 },
    ],
    userSignIn: { email: primary, password: realPassword },
  });
}

/** saved_logins_fail, graded on the user signing in themself with the password only they know. */
function userSignsInPlan(ctx: PlanContext): ScenarioPlan {
  const base = savedLoginsFailPlan(ctx);
  const primary = base.accounts[0];
  return {
    ...base,
    expectedSignInEmail: primary.email,
    expectedMemberNumber: primary.memberNumber,
  };
}

/** Every rung the user has for the site is present and fails. */
function allFailPlan(ctx: PlanContext): ScenarioPlan {
  const base = savedLoginsFailPlan(ctx, {
    identifierFirst: true,
    passkey: 'reject',
    smsSignIn: 'code',
    signUp: 'error',
    guest: 'browse',
  });
  const primary = base.savedPasswords[0].username;
  return {
    ...base,
    savedSession: { email: primary, state: 'expired' },
    passkeyEmail: primary,
    userSignIn: null,
  };
}

/** One member account whose saved password works, plus whatever else the scenario saves. */
function workingLoginPlan(ctx: PlanContext, overrides: Partial<ScenarioPlan>): ScenarioPlan {
  const [email] = savedLoginEmails(ctx.holderName, ctx.siteId);
  const password = randomPassword();
  const member = account(ctx, email, password);
  return plan({
    accounts: [member],
    savedPasswords: [{ username: email, password, lastUsedDaysAgo: 1 }],
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
    ...overrides,
  });
}

function sessionPlan(ctx: PlanContext, state: 'valid' | 'expired'): ScenarioPlan {
  const base = workingLoginPlan(ctx, {});
  return { ...base, savedSession: { email: base.accounts[0].email, state } };
}

function passkeyPlan(ctx: PlanContext, passkey: 'accept' | 'reject'): ScenarioPlan {
  const base = workingLoginPlan(ctx, {
    behavior: { ...BASE_BEHAVIOR, identifierFirst: true, passkey },
  });
  return { ...base, passkeyEmail: base.accounts[0].email };
}

function mintedAccountPlan(ctx: PlanContext, behavior: Partial<SiteBehavior>): ScenarioPlan {
  const member = account(ctx, ctx.mintedEmail ?? '', null, { phone: ctx.mintedPhone });
  return plan({
    behavior: { ...BASE_BEHAVIOR, ...behavior },
    accounts: [member],
    minted: 'account',
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
  });
}

/** An account the agent made earlier under its own inbox; the password was saved, the site wants a code too. */
function passwordEmail2faPlan(ctx: PlanContext): ScenarioPlan {
  const password = randomPassword();
  const member = account(ctx, ctx.mintedEmail ?? '', password);
  return plan({
    behavior: { ...BASE_BEHAVIOR, secondFactor: 'email_code' },
    accounts: [member],
    savedPasswords: [{ username: member.email, password, lastUsedDaysAgo: 1 }],
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
  });
}

function emailOtpPlan(ctx: PlanContext): ScenarioPlan {
  const member = account(ctx, ctx.connectedInbox ?? '', null);
  return plan({
    accounts: [member],
    minted: 'offered',
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
  });
}

function accountLockedPlan(ctx: PlanContext): ScenarioPlan {
  const [email] = savedLoginEmails(ctx.holderName, ctx.siteId);
  const password = randomPassword();
  return plan({
    accounts: [account(ctx, email, password, { locked: true })],
    savedPasswords: [{ username: email, password, lastUsedDaysAgo: 1 }],
  });
}

/** Freshest saved login is stale; the older one works. */
function failedLoginNotReofferedPlan(ctx: PlanContext): ScenarioPlan {
  const [stale, working] = savedLoginEmails(ctx.holderName, ctx.siteId);
  const password = randomPassword();
  const member = account(ctx, working, password);
  return plan({
    accounts: [account(ctx, stale, randomPassword()), member],
    savedPasswords: [
      { username: stale, password: randomPassword(), lastUsedDaysAgo: 1 },
      { username: working, password, lastUsedDaysAgo: 10 },
    ],
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
  });
}

/** Two working accounts; the prompt names the older one. */
function namedAccountPlan(ctx: PlanContext): ScenarioPlan {
  const [fresh, , older] = savedLoginEmails(ctx.holderName, ctx.siteId);
  const freshPassword = randomPassword();
  const olderPassword = randomPassword();
  const named = account(ctx, older, olderPassword);
  return plan({
    accounts: [account(ctx, fresh, freshPassword), named],
    savedPasswords: [
      { username: fresh, password: freshPassword, lastUsedDaysAgo: 1 },
      { username: older, password: olderPassword, lastUsedDaysAgo: 30 },
    ],
    expectedSignInEmail: named.email,
    expectedMemberNumber: named.memberNumber,
    namedAccountEmail: named.email,
  });
}

const openSitePlan = (behavior: Partial<SiteBehavior>): ScenarioPlan =>
  plan({ behavior: { ...BASE_BEHAVIOR, ...behavior }, minted: 'offered' });

const PLANNERS: Record<AuthTestSiteScenario, (ctx: PlanContext) => ScenarioPlan> = {
  password_retry: passwordRetryPlan,
  saved_logins_fail: (ctx) => savedLoginsFailPlan(ctx),
  user_signs_in: userSignsInPlan,
  all_fail: allFailPlan,
  minted_otp: (ctx) => mintedAccountPlan(ctx, {}),
  saved_session: (ctx) => sessionPlan(ctx, 'valid'),
  stale_session: (ctx) => sessionPlan(ctx, 'expired'),
  passkey: (ctx) => passkeyPlan(ctx, 'accept'),
  passkey_rejected: (ctx) => passkeyPlan(ctx, 'reject'),
  password_email_2fa: passwordEmail2faPlan,
  account_locked: accountLockedPlan,
  // The account exists but cannot be reached: its only way in is a code that never comes.
  code_never_arrives: (ctx) => ({
    ...mintedAccountPlan(ctx, { emailSignIn: 'code_withheld' }),
    expectedSignInEmail: null,
    expectedMemberNumber: null,
  }),
  expired_code: (ctx) => mintedAccountPlan(ctx, { emailSignIn: 'code_first_expired' }),
  phone_sms_otp: phoneSmsPlan,
  minted_sms_otp: (ctx) =>
    mintedAccountPlan(ctx, { passwordSignIn: false, emailSignIn: 'off', smsSignIn: 'code' }),
  magic_link: (ctx) => mintedAccountPlan(ctx, { emailSignIn: 'link' }),
  email_otp: emailOtpPlan,
  signup: () => openSitePlan({ signUp: 'open' }),
  signup_already_registered: (ctx) => mintedAccountPlan(ctx, { signUp: 'open' }),
  guest_purchase: () => openSitePlan(GUEST_SHOP),
  // Guests can buy, but only an account gets the lower price.
  member_discount_purchase: () => openSitePlan(MEMBER_PRICE_SHOP),
  member_discount_signup_fails_purchase: () =>
    openSitePlan({ ...MEMBER_PRICE_SHOP, signUp: 'error' }),
  paid_membership_purchase: () => openSitePlan({ ...MEMBER_PRICE_SHOP, membershipFeeCents: 999 }),
  signup_purchase: () => openSitePlan({ ...SHOP, signUp: 'open' }),
  signup_fails_purchase: () => openSitePlan({ ...SHOP, signUp: 'error' }),
  session_expires_at_checkout: (ctx) =>
    workingLoginPlan(ctx, { behavior: { ...BASE_BEHAVIOR, ...SHOP, expireSessionAtOrder: true } }),
  failed_login_not_reoffered: failedLoginNotReofferedPlan,
  created_account_reused: () => openSitePlan({ signUp: 'open', emailSignIn: 'off' }),
  named_account: namedAccountPlan,
};

export const planScenario = (scenario: AuthTestSiteScenario, ctx: PlanContext): ScenarioPlan =>
  PLANNERS[scenario](ctx);
