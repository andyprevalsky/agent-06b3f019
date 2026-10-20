/**
 * Rose Shop cases for codes and links: an emailed second factor, codes that
 * never arrive or arrive expired, sign-in links, texted codes, and a code sent
 * to the inbox the user connected.
 */

import { prisma } from '../../providers/database';
import { AUTH_TEST_SITE_BASE_PATH } from '../../domains/auth-test-site/config';
import { findSite } from '../../domains/auth-test-site/service';
import { fetchAgentPhoneMessagesSince } from '../../domains/agent-phone/service';
import {
  API_KEY,
  STUB_MAIL_DOMAIN,
  assert,
  cleanup,
  createFixture,
  createMintedIdentity,
  createUser,
  fetchReport,
  getPage,
  lastMailTo,
  pagePath,
  postForm,
  responseCookies,
  savedPasswordsInListedOrder,
  sessionCookie,
  test,
  withLocalSite,
  type Manifest,
} from './auth-test-site.testkit';

async function seed(base: string, userId: string, scenario: string): Promise<Manifest> {
  const created = await createFixture(base, { userId, scenario, publicBaseUrl: base });
  assert(created.status === 201, `${scenario} fixture expected 201, got ${created.status}`);
  return (await created.json()) as Manifest;
}

function trail(report: {
  attempts: Array<{ kind: string; outcome: string; reason: string | null }>;
}) {
  return report.attempts.map(
    (a) => `${a.kind}:${a.outcome}${a.reason === null ? '' : `:${a.reason}`}`
  );
}

function deviceChallengeToken(html: string): string {
  const input = html.match(/<input\b[^>]*\bname="challenge"[^>]*>/)?.[0] ?? '';
  const token = input.match(/\bvalue="([^"]+)"/)?.[1] ?? '';
  assert(token !== '', 'device approval form must bind its specific challenge');
  return token;
}

test('password_email_2fa: the saved password needs the code emailed to the agent inbox', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'password_email_2fa');
      assert(
        JSON.stringify(manifest.savedPasswordUsernames) === JSON.stringify([minted.email]),
        `the saved login must be the agent's own inbox: ${manifest.savedPasswordUsernames}`
      );
      assert(manifest.authOptionsPreview.mintedEmail === null, 'a saved password hides minted');
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'one saved login expected');
      const first = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      assert(
        (first.headers.get('location') ?? '').includes('/login/verify'),
        `password must lead to the code page: ${first.headers.get('location')}`
      );
      assert(sessionCookie(first) === '', 'no session before the code');
      const code =
        /verification code is (\d{6})/.exec(lastMailTo(sentMail, minted.email))?.[1] ?? '';
      assert(code !== '', 'second-factor code must be emailed');
      const wrong = await postForm(base, pagePath(manifest, '/login/verify'), {
        email: saved.username,
        code: code === '000000' ? '111111' : '000000',
      });
      assert((await wrong.text()).includes('incorrect'), 'wrong code must be refused');
      const verified = await postForm(base, pagePath(manifest, '/login/verify'), {
        email: saved.username,
        code,
      });
      assert(verified.status === 303, 'the emailed code must finish the sign-in');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'password_email_2fa',
        `one two-factor session expected: ${JSON.stringify(report.sessions)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('password_app_approval: a separate device approves and the original browser completes sign-in', async () => {
  const userId = await createUser();
  try {
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'password_app_approval');
      const device = manifest.appApprovalUser;
      assert(
        device && /^\d{2}$/.test(device.expectedNumber),
        'number-matching device fixture expected'
      );
      assert(device.challengeLifetimeSeconds === 300, 'five-minute challenge expected');
      assert(manifest.savedPasswordUsernames.length === 1, 'one saved password expected');
      assert(manifest.authOptionsPreview.mintedEmail === null, 'saved login suppresses minted');
      assert(manifest.authOptionsPreview.passkeyCount === 0, 'no passkey alternative');
      assert(manifest.authOptionsPreview.cookieBundleCount === 0, 'no saved-session alternative');
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'the task owner must own the saved password');
      const first = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      assert(first.status === 303, 'password must start the challenge');
      const pendingPath = first.headers.get('location') ?? '';
      assert(
        pendingPath.includes('/login/approve?'),
        `app challenge redirect expected: ${pendingPath}`
      );
      const pendingCookie = sessionCookie(first);
      assert(
        pendingCookie.startsWith('rose_shop_app_approval='),
        'pending cookie must bind the original browser'
      );
      const pendingHtml = await (await getPage(base, pendingPath, pendingCookie)).text();
      assert(
        pendingHtml.includes(device.expectedNumber),
        'browser must display the matching number'
      );
      assert(
        pendingHtml.includes('Rose Authenticator'),
        'browser must teach the user which app to open'
      );
      const deviceKey = new URL(device.deviceUrl).searchParams.get('key') ?? '';
      assert(deviceKey !== '', 'device capability expected');
      assert(
        !pendingHtml.includes(deviceKey) && !pendingHtml.includes('/device/approve'),
        'browser must not expose the separate device capability'
      );
      assert(!pendingHtml.includes('Approve sign-in'), 'task browser cannot approve itself');
      assert(
        (await fetchReport(base, manifest.siteId)).sessions.length === 0,
        'no session before app approval'
      );
      const devicePath = device.deviceUrl.slice(base.length);
      const deviceHtml = await (await getPage(base, devicePath)).text();
      assert(
        deviceHtml.includes('Sign-in number') && deviceHtml.includes('Approve sign-in'),
        'the separate device must offer number matching'
      );
      const approved = await postForm(base, devicePath, {
        number: device.expectedNumber,
        challenge: deviceChallengeToken(deviceHtml),
      });
      assert(approved.status === 200, `device approval expected 200, got ${approved.status}`);
      assert(
        (await approved.text()).includes('data-app-approval-status="approved"'),
        'device approval confirmation expected'
      );
      assert(
        (await fetchReport(base, manifest.siteId)).sessions.length === 0,
        'device approval alone cannot create a browser session'
      );
      const completed = await getPage(base, pendingPath, pendingCookie);
      assert(completed.status === 303, 'original browser must complete the approved challenge');
      const accountHtml = await (
        await getPage(base, pagePath(manifest, '/account'), responseCookies(completed))
      ).text();
      assert(accountHtml.includes(saved.username), 'the correct account must be signed in');
      assert(
        accountHtml.includes(manifest.expectedMemberNumber ?? '?'),
        'member-number deliverable must be reachable'
      );
      const report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'password_app_approval',
        'one app-approved password session expected'
      );
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify([
            'password:pending',
            'second_factor:pending',
            'app_approval:approved',
            'second_factor:signed_in',
          ]),
        `unexpected app-approval trail ${trail(report)}`
      );
      assert(sentMail.length === 0, 'app approval must not send an emailed fallback code');
      await getPage(base, pendingPath, pendingCookie);
      assert(
        (await fetchReport(base, manifest.siteId)).sessions.length === 1,
        'consumed challenge cannot create another session'
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('password_app_approval: device key, matching number and original browser cookie are required', async () => {
  const userId = await createUser();
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'password_app_approval');
      const device = manifest.appApprovalUser;
      assert(device, 'device fixture expected');
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'saved password expected');
      const first = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      const pendingPath = first.headers.get('location') ?? '';
      const pendingCookie = sessionCookie(first);
      const noKey = pagePath(manifest, '/device/approve');
      const wrongKey = `${noKey}&key=wrong-device-key`;
      for (const invalidPath of [noKey, wrongKey]) {
        assert(
          (await getPage(base, invalidPath)).status === 403,
          'device page requires its secret capability'
        );
        assert(
          (await postForm(base, invalidPath, { number: device.expectedNumber })).status === 403,
          'device approval requires its secret capability'
        );
      }
      const devicePath = device.deviceUrl.slice(base.length);
      const challengeToken = deviceChallengeToken(await (await getPage(base, devicePath)).text());
      for (const unknownChallenge of [undefined, 'unknown-challenge']) {
        const form: Record<string, string> = { number: device.expectedNumber };
        if (unknownChallenge !== undefined) form.challenge = unknownChallenge;
        assert(
          (await postForm(base, devicePath, form)).status === 409,
          'missing or unknown challenge token must be refused'
        );
      }
      const wrong = await postForm(base, devicePath, {
        number: device.expectedNumber === '99' ? '98' : '99',
        challenge: challengeToken,
      });
      assert(wrong.status === 400, 'wrong number must be rejected');
      let report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 0 && !report.attempts.some((a) => a.outcome === 'approved'),
        'wrong number cannot approve or sign in'
      );
      assert(
        (
          await postForm(base, devicePath, {
            number: device.expectedNumber,
            challenge: challengeToken,
          })
        ).status === 200,
        'correct app acknowledgment expected'
      );
      assert(
        (
          await postForm(base, devicePath, {
            number: device.expectedNumber,
            challenge: challengeToken,
          })
        ).status === 200,
        'repeated acknowledgment is idempotent'
      );
      await getPage(base, pendingPath);
      await getPage(base, pendingPath, 'rose_shop_app_approval=unrelated-browser-token');
      report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 0,
        'a different browser cannot consume the original challenge'
      );
      assert(
        report.attempts.filter((a) => a.kind === 'app_approval' && a.outcome === 'approved')
          .length === 1,
        'one acknowledgment event expected'
      );
      // A new password attempt issues a different challenge. Resubmitting the
      // old device form can acknowledge only its own already-approved request.
      const fresh = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      const freshCookie = sessionCookie(fresh);
      const freshChallenge = deviceChallengeToken(await (await getPage(base, devicePath)).text());
      assert(
        freshChallenge !== challengeToken,
        'new password attempt must issue a fresh challenge'
      );
      assert(
        (
          await postForm(base, devicePath, {
            number: device.expectedNumber,
            challenge: challengeToken,
          })
        ).status === 200,
        'old acknowledgment remains idempotent'
      );
      const freshPending = await getPage(base, pendingPath, freshCookie);
      assert(
        freshPending.status === 200 &&
          (await freshPending.text()).includes('data-app-approval-status="pending"'),
        'an old device form cannot approve the fresh challenge'
      );
      assert(
        (await fetchReport(base, manifest.siteId)).sessions.length === 0,
        'stale app form cannot sign in either browser'
      );
      assert(
        (await getPage(base, pendingPath, pendingCookie)).status === 303,
        'the original browser can finish'
      );
      report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.email === saved.username,
        'only the original account session exists'
      );
      assert(
        (await getPage(base, pendingPath, freshCookie)).status === 200,
        'fresh browser still awaits its own app approval'
      );
      assert(
        (await fetchReport(base, manifest.siteId)).sessions.length === 1,
        'old browser cookie consumes only its own challenge'
      );
      assert(
        (
          await postForm(base, devicePath, {
            number: device.expectedNumber,
            challenge: challengeToken,
          })
        ).status === 409,
        'consumed device challenge cannot be reused'
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('password_app_approval: an expired challenge cannot be acknowledged or create a session', async () => {
  const userId = await createUser();
  try {
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'password_app_approval');
      const device = manifest.appApprovalUser;
      assert(device, 'device fixture expected');
      const [saved] = await savedPasswordsInListedOrder(userId, manifest);
      assert(saved, 'saved password expected');
      const first = await postForm(base, pagePath(manifest, '/login'), {
        email: saved.username,
        password: saved.password,
      });
      const challenge = findSite(manifest.siteId)?.appApprovals[0];
      assert(challenge, 'the submitted password must issue an app challenge');
      const devicePath = device.deviceUrl.slice(base.length);
      const challengeToken = deviceChallengeToken(await (await getPage(base, devicePath)).text());
      // Exercise the owning expiry boundary without waiting five minutes.
      challenge.expiresAtMs = Date.now() - 1;
      const expired = await postForm(base, devicePath, {
        number: device.expectedNumber,
        challenge: challengeToken,
      });
      assert(expired.status === 410, 'expired device acknowledgment must be refused');
      const original = await getPage(
        base,
        first.headers.get('location') ?? '',
        sessionCookie(first)
      );
      assert(original.status === 410, 'the original browser must see an expired challenge');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.sessions.length === 0, 'expired challenge cannot sign in');
      assert(
        !report.attempts.some((a) => a.outcome === 'approved' || a.outcome === 'signed_in'),
        'expiry must never record a successful acknowledgment or sign-in'
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('code_never_arrives: every request is accepted and nothing is ever sent', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'code_never_arrives');
      for (let attempt = 0; attempt < 2; attempt++) {
        const requested = await postForm(base, pagePath(manifest, '/login/code'), {
          email: minted.email,
        });
        assert(requested.status === 303, 'the site must look like it sent a code');
      }
      assert(sentMail.length === 0, 'no code may be sent');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify(['code_request:code_withheld', 'code_request:code_withheld']),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('expired_code: the first code is already expired and a fresh one signs in', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'expired_code');
      const codeFromMail = () =>
        /sign-in code is (\d{6})/.exec(lastMailTo(sentMail, minted.email))?.[1] ?? '';
      await postForm(base, pagePath(manifest, '/login/code'), { email: minted.email });
      const stale = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: minted.email,
        code: codeFromMail(),
      });
      assert((await stale.text()).includes('has expired'), 'the first code must be expired');
      await postForm(base, pagePath(manifest, '/login/code'), { email: minted.email });
      const verified = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: minted.email,
        code: codeFromMail(),
      });
      assert(verified.status === 303, 'a fresh code must sign in');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify([
            'code_request:code_sent',
            'code_verify:rejected:expired_code',
            'code_request:code_sent',
            'code_verify:signed_in',
          ]),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('magic_link: the emailed link signs in once', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'magic_link');
      const requested = await postForm(base, pagePath(manifest, '/login/code'), {
        email: minted.email,
      });
      assert(
        (requested.headers.get('location') ?? '').includes('/login/link/sent'),
        'a link site must not show a code form'
      );
      const body = lastMailTo(sentMail, minted.email);
      assert(!/\b\d{6}\b/.test(body.replace(/https?:\S+/g, '')), 'the mail must carry no code');
      const link = /https?:\S+/.exec(body)?.[0] ?? '';
      assert(
        link.startsWith(`${base}${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}/login/link?`),
        `link ${link}`
      );
      const opened = await fetch(link, { redirect: 'manual' });
      assert(opened.status === 303 && sessionCookie(opened) !== '', 'the link must sign in');
      const again = await fetch(link, { redirect: 'manual' });
      assert(again.status === 200, 'a used link must not sign in again');
      const report = await fetchReport(base, manifest.siteId);
      assert(
        report.sessions.length === 1 && report.sessions[0]?.method === 'magic_link',
        `one link session expected: ${JSON.stringify(report.sessions)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('minted_sms_otp: the texted code signs in the account on the agent phone', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId, '+15555550142');
    await withLocalSite(async ({ base }) => {
      const manifest = await seed(base, userId, 'minted_sms_otp');
      assert(manifest.mintedPhone === minted.phone, `minted phone ${manifest.mintedPhone}`);
      const login = await (await getPage(base, pagePath(manifest, '/login'))).text();
      assert(!login.includes('type="password"'), 'a phone-only site has no password form');
      assert(login.includes('Text me a sign-in code'), 'text option expected');
      const requested = await postForm(base, pagePath(manifest, '/login/sms'), {
        phone: '(555) 555-0142',
      });
      assert(requested.status === 303, 'a text request redirects to code entry');
      // On a benchmark stack the phone is a mock, so the text lands in the number's
      // local inbox, which is what the agent's code poller reads.
      const inbox = await fetchAgentPhoneMessagesSince(userId, new Date(Date.now() - 60_000), 10);
      assert(
        inbox.length === 1 && inbox[0]?.to === minted.phone,
        `one text to the agent phone expected, got ${inbox.length}`
      );
      const code = /sign-in code is (\d{6})/.exec(inbox[0]?.body ?? '')?.[1];
      assert(code !== undefined, 'the text must carry the sign-in code');
      assert(
        code === findSite(manifest.siteId)?.codes.find((issued) => issued.purpose === 'sms')?.code,
        'the texted code is the one the site issued'
      );
      const verified = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        phone: '+1 555 555 0142',
        code,
      });
      assert(verified.status === 303, 'the texted code must sign in');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.sessions[0]?.method === 'sms_code', 'sms session expected');
      assert(
        report.attempts[0]?.kind === 'sms_request' && report.attempts[0]?.outcome === 'code_sent',
        `the request is logged as sent: ${JSON.stringify(report.attempts[0])}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('email_otp: the code goes to the inbox the user connected', async () => {
  const userId = await createUser('Avery Ross');
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'email_otp');
      const inbox = manifest.expectedSignInEmail ?? '';
      assert(
        inbox === `avery.ross.${manifest.siteId}@${STUB_MAIL_DOMAIN}`,
        `the account lives under the user's own connected inbox, got ${inbox}`
      );
      assert(
        JSON.stringify(manifest.authOptionsPreview.emailOtpInboxes) === JSON.stringify([inbox]),
        `auth options must list the inbox for email OTP: ${JSON.stringify(manifest.authOptionsPreview)}`
      );
      assert(manifest.authOptionsPreview.mintedEmail === minted.email, 'minted stays offered');
      assert(manifest.authOptionsPreview.passwordUsernames.length === 0, 'nothing is saved');
      await postForm(base, pagePath(manifest, '/login/code'), { email: inbox });
      const code = /sign-in code is (\d{6})/.exec(lastMailTo(sentMail, inbox))?.[1] ?? '';
      assert(code !== '', 'the code must be mailed to the connected inbox');
      const verified = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: inbox,
        code,
      });
      assert(verified.status === 303, 'the code must sign in');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.sessions[0]?.email === inbox, 'signed in as the connected inbox account');

      const removed = await fetch(
        `${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${manifest.siteId}`,
        { method: 'DELETE', headers: { 'X-API-Key': API_KEY } }
      );
      assert(removed.status === 200, 'delete');
      const left = await prisma.emailIntegrationCredential.count({ where: { userId } });
      assert(left === 0, 'the fixture inbox is disconnected at teardown');
    });
  } finally {
    await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
    await prisma.integration.deleteMany({ where: { userId } });
    await cleanup(userId);
  }
});
