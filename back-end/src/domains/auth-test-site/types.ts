/**
 * Larkspur Members — a self-hosted sign-in site for browser-auth benchmarks.
 *
 * Live sites put CAPTCHAs and bot walls in front of sign-in, so they cannot
 * prove the auth ladder deterministically. This fixture is an ordinary
 * server-rendered members site whose accounts are seeded per run and whose
 * every sign-in attempt is recorded for the benchmark evaluator.
 *
 *   run_benchmark.py ──POST /fixtures {userId, scenario, publicBaseUrl}──► service
 *        │                 seeds BrowserPassword / MintedAccount rows for
 *        │                 realm larkspur-<siteId>.test, returns entryUrl
 *        ▼
 *   browser agent ──GET <entryUrl>──► /login ──POST password──► /account
 *        │                       └──► /login/code ──POST email──► Primitive
 *        │                                 sign-in email ──► minted inbox ──► OTP
 *        │                                 injection ──► /login/code/verify
 *        ▼
 *   run_benchmark.py ──GET /fixtures/:siteId/report──► attempts + sessions
 *
 * Page state per site:
 *
 *   signed_out ──password ok──────────────► signed_in
 *       │  └────password rejected──► signed_out (attempt recorded)
 *       └──code requested──► code_pending ──code ok──► signed_in
 *                                  └──code rejected──► code_pending
 */

export const AUTH_TEST_SITE_SCENARIOS = ['password_retry', 'all_fail', 'minted_otp'] as const;
export type AuthTestSiteScenario = (typeof AUTH_TEST_SITE_SCENARIOS)[number];

export type SignInMethod = 'password' | 'email_code';
export type AttemptKind = 'password' | 'code_request' | 'code_verify';
export type AttemptOutcome =
  'signed_in' | 'rejected' | 'code_sent' | 'code_withheld' | 'code_delivery_failed';
export type RejectionReason =
  'wrong_password' | 'unknown_account' | 'no_password' | 'invalid_code' | null;

export interface SiteAccount {
  email: string;
  /** null = passwordless account (email-code sign-in only). */
  password: string | null;
  memberNumber: string;
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

export interface IssuedCode {
  email: string;
  code: string;
  expiresAtMs: number;
  consumed: boolean;
}

export interface SiteSession {
  token: string;
  email: string;
  method: SignInMethod;
  createdAt: string;
  endedAt: string | null;
}

export interface AuthTestSite {
  siteId: string;
  scenario: AuthTestSiteScenario;
  userId: string;
  realm: string;
  entryUrl: string;
  createdAtMs: number;
  accounts: SiteAccount[];
  savedPasswords: SavedPasswordRecord[];
  mintedEmail: string | null;
  attempts: SignInAttempt[];
  sessions: SiteSession[];
  codes: IssuedCode[];
}

export interface CreateAuthTestSiteInput {
  userId: string;
  scenario: AuthTestSiteScenario;
  publicBaseUrl: string;
}

export interface AuthTestSiteManifest {
  siteId: string;
  scenario: AuthTestSiteScenario;
  realm: string;
  entryUrl: string;
  savedPasswordUsernames: string[];
  mintedEmail: string | null;
  /** Account the scenario expects the agent to reach, or null when none can. */
  expectedSignInEmail: string | null;
  expectedMemberNumber: string | null;
  savedBrowserAuthHidden: boolean;
  /** What /api/auth-options returns for the realm — the ladder the agent will see. */
  authOptionsPreview: { passwordUsernames: string[]; mintedEmail: string | null };
}

export interface AuthTestSiteReport {
  siteId: string;
  scenario: AuthTestSiteScenario;
  realm: string;
  entryUrl: string;
  createdAt: string;
  mintedEmail: string | null;
  savedPasswords: SavedPasswordReport[];
  attempts: SignInAttempt[];
  sessions: Array<{
    email: string;
    method: SignInMethod;
    createdAt: string;
    endedAt: string | null;
  }>;
}

export type PasswordSignInResult =
  { ok: true; token: string } | { ok: false; reason: Exclude<RejectionReason, null> };

export type CodeVerifyResult = { ok: true; token: string } | { ok: false };

export class AuthTestSiteError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = 'AuthTestSiteError';
  }
}
