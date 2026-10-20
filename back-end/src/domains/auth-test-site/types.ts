/**
 * Rose Shop — a self-hosted test site for browser-auth benchmarks.
 *
 * Live sites put CAPTCHAs and bot walls in front of sign-in, so they cannot
 * prove the auth ladder deterministically. This fixture is an ordinary
 * server-rendered shop whose accounts are seeded per run and whose every
 * sign-in, sign-up and order event is recorded for the benchmark evaluator.
 *
 *   run_benchmark.py ──POST /fixtures {userId, scenario, publicBaseUrl}──► service
 *        │                 seeds BrowserPassword / Cookie / PasskeyCredential /
 *        │                 MintedAccount rows for realm rose-shop-<siteId>
 *        ▼
 *   browser agent ──GET <entryUrl>──► /login ──► /account | /checkout ──► /orders/:n
 *        ▼
 *   run_benchmark.py ──GET /fixtures/:siteId/report──► attempts, sessions, orders
 *
 * Page state per site:
 *
 *   signed_out ──password | passkey | code | link | saved session──► signed_in
 *       │  └────any of them rejected──► signed_out (attempt recorded)
 *       ├──password ok + second factor──► code_pending ──code ok──► signed_in
 *       ├──password ok + app approval──► approval_pending ──separate app confirms──► signed_in
 *       └──sign-up──► verify_pending ──code ok──► signed_in
 *   signed_in | guest ──checkout──► order placed (exactly once per submit)
 */

export const AUTH_TEST_SITE_SCENARIOS = [
  'password_retry',
  'saved_logins_fail',
  'user_signs_in',
  'all_fail',
  'minted_otp',
  'saved_session',
  'stale_session',
  'passkey',
  'passkey_rejected',
  'password_email_2fa',
  'password_app_approval',
  'account_locked',
  'code_never_arrives',
  'expired_code',
  'minted_sms_otp',
  'magic_link',
  'email_otp',
  'signup',
  'signup_already_registered',
  'guest_purchase',
  'member_discount_purchase',
  'member_discount_signup_fails_purchase',
  'paid_membership_purchase',
  'signup_purchase',
  'signup_fails_purchase',
  'session_expires_at_checkout',
  'failed_login_not_reoffered',
  'created_account_reused',
  'named_account',
] as const;
export type AuthTestSiteScenario = (typeof AUTH_TEST_SITE_SCENARIOS)[number];

export type SignInMethod =
  | 'password'
  | 'password_email_2fa'
  | 'password_app_approval'
  | 'email_code'
  | 'sms_code'
  | 'magic_link'
  | 'passkey'
  | 'saved_session'
  | 'signup';

export type AttemptKind =
  | 'password'
  | 'code_request'
  | 'code_verify'
  | 'sms_request'
  | 'sms_verify'
  | 'link_request'
  | 'link_open'
  | 'passkey'
  | 'session'
  | 'second_factor'
  | 'app_approval'
  | 'signup'
  | 'signup_verify'
  | 'guest'
  | 'order'
  | 'run_marker';

export type AttemptOutcome =
  | 'signed_in'
  | 'rejected'
  | 'code_sent'
  | 'code_withheld'
  | 'code_delivery_failed'
  | 'resumed'
  | 'pending'
  | 'approved'
  | 'started'
  | 'placed';

export type RejectionReason =
  | 'wrong_password'
  | 'unknown_account'
  | 'no_password'
  | 'invalid_code'
  | 'expired_code'
  | 'expired_challenge'
  | 'locked'
  | 'expired_session'
  | 'passkey_not_recognized'
  | 'passkey_unavailable'
  | 'already_registered'
  | 'signup_unavailable'
  | 'card_declined'
  | 'sign_in_required'
  | null;

/** What the site offers and how it behaves; a scenario is one combination. */
export interface SiteBehavior {
  /** Ask for the email first, then offer the sign-in methods for that account. */
  identifierFirst: boolean;
  passwordSignIn: boolean;
  /** code_withheld: claims to send but never does; code_first_expired: the first code issued is already expired. */
  emailSignIn: 'off' | 'code' | 'code_withheld' | 'code_first_expired' | 'link';
  smsSignIn: 'off' | 'code';
  passkey: 'off' | 'accept' | 'reject';
  secondFactor: 'none' | 'email_code' | 'app_approval';
  signUp: 'off' | 'open' | 'error';
  /** browse: guests see the shop only; checkout: guests can also buy. */
  guest: 'off' | 'browse' | 'checkout';
  shop: boolean;
  /** Percent off every item for signed-in members; 0 = members and guests pay the same. */
  memberDiscountPercent: number;
  /** Monthly price of the membership that earns the discount; 0 = membership is free. */
  membershipFeeCents: number;
  /** The first order submit ends the session and asks the member to sign in again. */
  expireSessionAtOrder: boolean;
}

export interface SiteAccount {
  email: string;
  /** null = passwordless account (code / link / passkey sign-in only). */
  password: string | null;
  memberNumber: string;
  name: string | null;
  phone: string | null;
  locked: boolean;
  /** false until a sign-up confirms its emailed code. */
  verified: boolean;
  origin: 'seed' | 'signup';
}

export interface SavedPasswordSeed {
  username: string;
  password: string;
  lastUsedDaysAgo: number;
}

export interface SavedPasswordRecord {
  id: string;
  username: string;
  matchesAccount: boolean;
}

export interface SavedPasswordReport extends SavedPasswordRecord {
  disabledAt: string | null;
  disabledReason: string | null;
}

export interface SignInAttempt {
  at: string;
  kind: AttemptKind;
  email: string;
  outcome: AttemptOutcome;
  reason: RejectionReason;
}

export type CodePurpose = 'sign_in' | 'second_factor' | 'signup' | 'sms';

export interface IssuedCode {
  email: string;
  code: string;
  purpose: CodePurpose;
  expiresAtMs: number;
  consumed: boolean;
}

export interface SiteSession {
  token: string;
  email: string;
  method: SignInMethod;
  createdAt: string;
  endedAt: string | null;
  /** Seeded as the user's saved browser session; first use is logged as "resumed". */
  seeded: boolean;
  resumed: boolean;
}

export interface AppApprovalChallenge {
  token: string;
  email: string;
  number: string;
  expiresAtMs: number;
  approvedAt: string | null;
  consumed: boolean;
}

export interface SitePasskey {
  /** base64url credential id, as WebAuthn reports it. */
  credentialId: string;
  publicKeyPem: string;
  email: string;
  rpId: string;
}

export interface CartLine {
  id: string;
  quantity: number;
}

export interface SiteOrder {
  orderNumber: string;
  /** null = guest order. */
  email: string | null;
  lines: CartLine[];
  totalCents: number;
  at: string;
  purchaseId: string | null;
  /** The cart that paid for it; a guest receipt is readable only with this cart's cookie. */
  cartToken: string | null;
}

/**
 * password_retry decides the working login at sign-in time, so the agent meets
 * every scenario failure whichever saved login it tries first:
 *
 *   distinct saved login #1 tried ──► rejections[0]
 *   distinct saved login #2 tried ──► rejections[1]
 *   distinct saved login #3 tried ──► becomes the member account ──► signed in
 *
 * A login that was rejected keeps failing with the same reason.
 */
export interface SavedLoginLadder {
  logins: Array<{ email: string; password: string }>;
  rejections: Array<Exclude<RejectionReason, null>>;
  memberNumber: string;
  served: Array<{ email: string; reason: Exclude<RejectionReason, null> }>;
}

export interface AuthTestSite {
  siteId: string;
  scenario: AuthTestSiteScenario;
  behavior: SiteBehavior;
  userId: string;
  realm: string;
  entryUrl: string;
  /** scheme://host of the public URL; WebAuthn origin and cookie domain derive from it. */
  publicOrigin: string;
  createdAtMs: number;
  /** The benchmark user's name; every seeded site account is theirs. */
  holderName: string | null;
  /** The account the agent can reach; null until a ladder or sign-up resolves, or when none can. */
  signInEmail: string | null;
  ladder: SavedLoginLadder | null;
  accounts: SiteAccount[];
  savedPasswords: SavedPasswordRecord[];
  mintedEmail: string | null;
  mintedPhone: string | null;
  /** The user's own connected inbox, when a site account lives under it. */
  connectedInbox: string | null;
  /** Row ids of the seeded passkey / saved-session bundle, for the post-run report. */
  passkeyRowId: string | null;
  savedSessionBundleId: string | null;
  passkey: SitePasskey | null;
  passkeyChallenges: Array<{ challenge: string; issuedAtMs: number; consumed: boolean }>;
  /** Tokens of the user's saved session that the site no longer honors. */
  staleSessionTokens: string[];
  staleSessionSeen: boolean;
  savedSessionEmail: string | null;
  attempts: SignInAttempt[];
  sessions: SiteSession[];
  codes: IssuedCode[];
  appApprovalDeviceKey: string | null;
  appApprovalNumber: string;
  appApprovals: AppApprovalChallenge[];
  linkTokens: Array<{ token: string; email: string; expiresAtMs: number; consumed: boolean }>;
  carts: Record<string, CartLine[]>;
  /** Carts whose owner chose to check out without an account. */
  guestCartTokens: string[];
  orders: SiteOrder[];
  sessionExpiredAtOrder: boolean;
  /** Path of the last page the browser was served; shows what the agent left open. */
  lastPagePath: string | null;
}

export interface CreateAuthTestSiteInput {
  userId: string;
  scenario: AuthTestSiteScenario;
  publicBaseUrl: string;
}

export interface AuthOptionsPreview {
  passwordUsernames: string[];
  mintedEmail: string | null;
  passkeyCount: number;
  cookieBundleCount: number;
  emailOtpInboxes: string[];
}

export interface AuthTestSiteManifest {
  siteId: string;
  scenario: AuthTestSiteScenario;
  realm: string;
  entryUrl: string;
  savedPasswordUsernames: string[];
  mintedEmail: string | null;
  mintedPhone: string | null;
  /** Account fixed at creation for the agent to reach; null when none can or the run decides. */
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
  /** The account a prompt names with {auth_test_site_account}. */
  namedAccountEmail: string | null;
  /** What the user themself would type when asked to sign in; never offered to the agent. */
  userSignIn: { email: string; password: string } | null;
  /** Separate app/device capability for the stand-in user; never part of the agent goal. */
  appApprovalUser: {
    deviceUrl: string;
    expectedNumber: string;
    challengeLifetimeSeconds: number;
  } | null;
  savedSession: 'valid' | 'expired' | null;
  savedBrowserAuthHidden: boolean;
  /** What /api/auth-options returns for the realm — the ladder the agent will see. */
  authOptionsPreview: AuthOptionsPreview;
}

export interface AuthTestSiteReport {
  siteId: string;
  scenario: AuthTestSiteScenario;
  realm: string;
  entryUrl: string;
  createdAt: string;
  mintedEmail: string | null;
  mintedPhone: string | null;
  signInEmail: string | null;
  savedPasswords: SavedPasswordReport[];
  passkey: { disabledAt: string | null; signCount: number } | null;
  savedSessionBundle: { disabledAt: string | null } | null;
  accounts: Array<{
    email: string;
    memberNumber: string;
    origin: SiteAccount['origin'];
    verified: boolean;
  }>;
  attempts: SignInAttempt[];
  sessions: Array<{
    email: string;
    method: SignInMethod;
    createdAt: string;
    endedAt: string | null;
  }>;
  orders: Array<Omit<SiteOrder, 'lines'> & { itemIds: string[] }>;
  lastPagePath: string | null;
}

export type PasswordSignInResult =
  | { ok: true; token: string }
  | { ok: 'second_factor' }
  | { ok: 'app_approval'; challengeToken: string }
  | { ok: false; reason: Exclude<RejectionReason, null> };

export type CodeVerifyResult =
  { ok: true; token: string } | { ok: false; reason: 'invalid_code' | 'expired_code' };

export class AuthTestSiteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'AuthTestSiteError';
  }
}
