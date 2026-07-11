/**
 * Semantic Test: Login via Phone + OTP.
 *
 * Verifies a user can log in from the marketing homepage by clicking the
 * Login button, entering their phone number, receiving an OTP, entering the
 * OTP, and reaching an authenticated state with a persisted session.
 *
 * Grounded against the running app — selectors and session keys were
 * verified against live Chromium before being committed here.
 */
import { expect, test } from '@playwright/test';

import {
  FRONTEND_URL,
  IS_PROD,
  TEST_OTP,
  TEST_PHONE_DIGITS,
  TEST_PHONE_E164,
  allowAuthEndpoints,
  attachRecorder,
  clearAppSession,
  forceLoggedOut,
  has5xxAuth,
  hasUncaughtErrors,
} from './helpers';

test.describe('login', () => {
  // The OTP flow relies on local/review magic OTP credentials which are rejected
  // by production Supabase. Skip when running against prod.
  test.skip(IS_PROD, 'Login OTP flow requires dev environment (magic OTP)');

  test('phone + OTP flow reaches authenticated state', async ({ context, page }) => {
    const rec = attachRecorder(page);

    // Block auto-login endpoints so we can exercise the logged-out path.
    await forceLoggedOut(context);

    // ?no-auto-login: exercise the MANUAL login path deterministically — dev
    // auto-login otherwise races this spec (its send-otp/verify-otp satisfy
    // our waitForResponse predicates and its session churn can clobber state).
    await page.goto(`${FRONTEND_URL}/terminal?no-auto-login=1`, {
      waitUntil: 'domcontentloaded',
    });
    await clearAppSession(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // ── Step 1: Open the auth modal from the Login button ────────────────
    const loginBtn = page.getByRole('button', { name: 'Login' });
    await expect(loginBtn, 'Login button missing in header').toBeVisible();

    // Re-enable verify-otp before the real login attempt.
    await allowAuthEndpoints(context);
    await loginBtn.click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog, 'Login button did not open auth modal').toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Start Building.' }),
      'Phone step heading missing',
    ).toBeVisible();

    // Modal must be fully on-screen — catches positioning regressions.
    const onScreen = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return (
        r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
      );
    });
    expect(onScreen, 'Auth modal rendered off-screen').toBe(true);

    // ── Step 2: Submit phone number ──────────────────────────────────────
    const sendOtp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/send-otp') && r.request().method() === 'POST',
    );
    await page.locator('#phone').fill(TEST_PHONE_DIGITS);
    await page.getByRole('button', { name: 'Continue' }).click();

    const sendOtpRes = await sendOtp;
    expect(sendOtpRes.status(), `send-otp non-2xx: ${sendOtpRes.status()}`).toBeLessThan(300);
    expect(
      (sendOtpRes.request().postDataJSON() as { phone?: string }).phone,
      'send-otp body did not carry E.164 phone',
    ).toBe(TEST_PHONE_E164);

    await expect(
      page.getByRole('heading', { name: 'Verify Code' }),
      'Modal did not advance to OTP step',
    ).toBeVisible();

    // ── Step 3: Submit OTP ──────────────────────────────────────────────
    const verifyOtp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/verify-otp') && r.request().method() === 'POST',
    );
    const inviteCheck = page.waitForResponse(
      (r) => r.url().includes('/api/invite-codes/check') && r.request().method() === 'GET',
    );
    await page.locator('#otp').fill(TEST_OTP);
    await page
      .locator('label:has-text("I authorize SMS communication") input[type="checkbox"]')
      .check();
    await page.getByRole('button', { name: 'Verify', exact: true }).click();

    const verifyOtpRes = await verifyOtp;
    expect(verifyOtpRes.status(), `verify-otp non-2xx: ${verifyOtpRes.status()}`).toBeLessThan(300);

    // ── Step 3b: Waitlist gate (invite-gated onboarding) ─────────────────
    // Users without a redeemed invite code get the "You're On The Waitlist!"
    // modal after login (server-side User.usedInviteCode). Redeem the master
    // code through the real UI so the gate path is exercised end to end.
    // Already-ungated users (prior redemption) skip straight through.
    const inviteCodeInput = page.getByLabel('Invite code');
    const inviteCheckRes = await inviteCheck;
    expect(
      inviteCheckRes.status(),
      `invite-codes/check non-2xx: ${inviteCheckRes.status()}`,
    ).toBeLessThan(300);
    const { needsInviteCode } = (await inviteCheckRes.json()) as { needsInviteCode: boolean };
    if (needsInviteCode) {
      await expect(inviteCodeInput, 'Invite gate did not render').toBeVisible();
      const useCode = page.waitForResponse(
        (r) => r.url().includes('/api/invite-codes/use') && r.request().method() === 'POST',
      );
      await inviteCodeInput.fill('181818');
      await page.getByRole('button', { name: 'Join with invite code' }).click();
      const useRes = await useCode;
      expect(useRes.status(), `invite-codes/use non-2xx: ${useRes.status()}`).toBeLessThan(300);
    }

    // ── Step 4: Verify authenticated state ───────────────────────────────
    await expect(dialog, 'Modal did not close after Verify').toBeHidden();

    // rose-session is the app's custom session key (checked live, not sb-*).
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const raw = localStorage.getItem('rose-session');
            return raw ? raw.includes('access_token') : false;
          }),
        { message: 'Session was not persisted to localStorage[rose-session]', timeout: 5_000 },
      )
      .toBe(true);

    // Console should log "Phone verification complete".
    await expect
      .poll(() => rec.console.some((m) => m.text.includes('[Auth] Phone verification complete')), {
        timeout: 5_000,
        message: 'Auth completion log missing',
      })
      .toBe(true);

    // ── Step 5: Clicking Login while authed navigates to /terminal ──────
    // (LoginButton handler: `navigate('/terminal')` when user exists.)
    // Wait for React to process the new session before re-clicking — the auth
    // hook emits a chain of [Auth] State changed events after verify-otp and
    // the `user` closure must reflect the authed state before click handler
    // fires, otherwise `handleClick` falls through to setModalOpen(true).
    await expect
      .poll(
        () =>
          rec.console.some(
            (m) =>
              m.text.includes('[Auth] State changed') && m.text.includes('isFullySignedIn: true'),
          ),
        { timeout: 10_000, message: 'Auth hook never reached isFullySignedIn: true after verify' },
      )
      .toBe(true);

    await expect(loginBtn, 'Login button disappeared mid-flow').toBeVisible();
    await loginBtn.click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 5_000 }).toBe('/terminal');
    await expect(dialog, 'Modal reopened — auth state not detected').toBeHidden();

    // ── Invariants ───────────────────────────────────────────────────────
    expect(hasUncaughtErrors(rec), 'Uncaught errors during login flow').toEqual([]);
    expect(has5xxAuth(rec), 'Auth endpoint returned 5xx').toEqual([]);
  });
});
