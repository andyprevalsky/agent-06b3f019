/** Real routes and issuer state, no outbound transport credentials or live messages. */
import { prisma } from '../../providers/database';
import { findSite } from '../../domains/auth-test-site/service';
import type { AuthTestSite } from '../../domains/auth-test-site/types';
import {
  assert,
  cleanup,
  createFixture,
  createUser,
  fetchReport,
  pagePath,
  postForm,
  test,
  withLocalSite,
} from './auth-test-site.testkit';
/** Only deliberate resend fixtures advance their synthetic issuer timestamp. */
function allowNextPhoneRequest(site: AuthTestSite) {
  const challenge = site.codes.at(-1)?.phoneChallenge;
  if (challenge) challenge.issuedAt = new Date(Date.now() - 60_001).toISOString();
}
test('phone_sms_otp uses only owned configured phone, no minted identity or AgentPhone mirror', async () => {
  const userId = await createUser();
  const prior = process.env.CLOUD_IPHONE_ENABLED;
  try {
    process.env.CLOUD_IPHONE_ENABLED = '1';
    await prisma.user.update({
      where: { userId },
      data: { phone: '+19729777432', isAnonymous: false },
    });
    await prisma.iPhoneDevice.create({
      data: { userId, providerDeviceId: `phone-sms-${userId}`, enabled: true },
    });
    await withLocalSite(async ({ base }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'phone_sms_otp',
        publicBaseUrl: base,
      });
      assert(created.status === 201, `phone_sms_otp expected201 got${created.status}`);
      const manifest = await created.json();
      assert(manifest.mintedPhone === null && manifest.mintedEmail === null, 'No minted identity');
      assert(
        (await prisma.mintedAccount.count({ where: { userId } })) === 0,
        'No minted provisioning'
      );
      await postForm(base, pagePath(manifest, '/login/sms'), { phone: '+15550000000' });
      const site = findSite(manifest.siteId)!;
      assert(site.codes.length === 1, 'Issuer challenge expected');
      const first = site.codes[0]!;
      const report = await fetchReport(base, manifest.siteId);
      assert(!JSON.stringify(report).includes(first.code), 'Report leaked OTP');
      assert(!JSON.stringify(report).includes('+19729777432'), 'Report leaked full phone');
      assert(
        (await prisma.agentPhoneMessage.count({ where: { userId } })) === 0,
        'No AgentPhone shortcut'
      );
      allowNextPhoneRequest(site);
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      assert(first.consumed, 'Resend invalidates previous challenge');
      const newest = site.codes.at(-1)!;
      const denied = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        code: first.code,
      });
      assert(denied.status !== 303, 'Old code cannot sign in');
      // Force a six-digit collision: only the exact accepted replacement gains consumption evidence.
      first.code = newest.code;
      const ok = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        code: newest.code,
      });
      assert(ok.status === 303, 'Latest code signs in');
      const replay = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        code: newest.code,
      });
      assert(replay.status !== 303, 'Single consumption');
      const final = (await fetchReport(base, manifest.siteId)) as Awaited<
        ReturnType<typeof fetchReport>
      > & {
        phoneSmsChallenges: Array<{
          challengeId: string;
          issuedAt: string;
          expiresAt: string;
          consumedAt: string | null;
          deliveryAck: boolean;
          liveTransport: boolean;
          codeDigest: string;
        }>;
      };
      assert(final.phoneSmsChallenges.length === 2, 'Each resend has a separate marker');
      assert(
        final.phoneSmsChallenges.every((c) => c.liveTransport === false),
        'Offline/mock issuer cannot claim live transport'
      );
      assert(
        final.phoneSmsChallenges[0]!.challengeId !== final.phoneSmsChallenges[1]!.challengeId,
        'Fresh request marker'
      );
      assert(
        final.phoneSmsChallenges[0]!.consumedAt === null,
        'Invalidation is not successful consumption'
      );
      assert(final.phoneSmsChallenges[1]!.consumedAt !== null, 'Successful consumption timestamp');
      assert(final.phoneSmsChallenges[1]!.codeDigest.length === 64, 'Keyed code proof digest');
      assert(final.sessions.length === 1, 'Exactly one authenticated session');
      assert(!JSON.stringify(final).includes(newest.code), 'Final report hides code');
      assert(!JSON.stringify(final).includes('+19729777432'), 'Final report hides destination');
      allowNextPhoneRequest(site);
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      site.codes.at(-1)!.expiresAtMs = Date.now() - 1;
      const expired = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        code: site.codes.at(-1)!.code,
      });
      assert(expired.status !== 303, 'Expired current code rejected');
    });
  } finally {
    if (prior === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
    else process.env.CLOUD_IPHONE_ENABLED = prior;
    await prisma.iPhoneDevice.deleteMany({ where: { userId } });
    await cleanup(userId);
  }
});

test('phone_sms_otp rejects missing or ineligible cloud phone configuration', async () => {
  const userId = await createUser();
  const prior = process.env.CLOUD_IPHONE_ENABLED;
  try {
    process.env.CLOUD_IPHONE_ENABLED = '1';
    await withLocalSite(async ({ base }) => {
      const create = () =>
        createFixture(base, { userId, scenario: 'phone_sms_otp', publicBaseUrl: base });
      assert((await create()).status === 409, 'Missing configuration rejected');
      await prisma.user.update({
        where: { userId },
        data: { phone: '+15555550000', isAnonymous: false },
      });
      await prisma.iPhoneDevice.create({
        data: { userId, providerDeviceId: `ineligible-${userId}`, enabled: true },
      });
      assert((await create()).status === 409, 'Foreign/noneligible account rejected');
      await prisma.user.update({ where: { userId }, data: { phone: '+19729777432' } });
      process.env.CLOUD_IPHONE_ENABLED = '0';
      assert((await create()).status === 409, 'Rollout-off rejected');
    });
  } finally {
    if (prior === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
    else process.env.CLOUD_IPHONE_ENABLED = prior;
    await prisma.iPhoneDevice.deleteMany({ where: { userId } });
    await cleanup(userId);
  }
});

test('phone_sms_otp failed replacement cannot authenticate and cannot revive an earlier challenge', async () => {
  const userId = await createUser();
  const saved = {
    CLOUD_IPHONE_ENABLED: process.env.CLOUD_IPHONE_ENABLED,
    SURGE_API_KEY: process.env.SURGE_API_KEY,
    SURGE_ACCOUNT_ID: process.env.SURGE_ACCOUNT_ID,
    BLACKBOX_TEST_FAKE_SURGE: process.env.BLACKBOX_TEST_FAKE_SURGE,
  };
  const originalFetch = globalThis.fetch;
  try {
    process.env.CLOUD_IPHONE_ENABLED = '1';
    await prisma.user.update({
      where: { userId },
      data: { phone: '+19729777432', isAnonymous: false },
    });
    await prisma.iPhoneDevice.create({
      data: { userId, providerDeviceId: `failed-sms-${userId}`, enabled: true },
    });
    await withLocalSite(async ({ base }) => {
      const fixture = await createFixture(base, {
        userId,
        scenario: 'phone_sms_otp',
        publicBaseUrl: base,
      });
      assert(fixture.status === 201, 'Configured fixture');
      const manifest = await fixture.json();
      process.env.SURGE_API_KEY = 'synthetic-sms-key';
      process.env.SURGE_ACCOUNT_ID = 'synthetic-account';
      process.env.BLACKBOX_TEST_FAKE_SURGE = '1';
      const { markMessagingFetchFakesInstalled } = await import('../../providers/smsTransportMock');
      markMessagingFetchFakesInstalled();
      let rejectSend = false,
        throwSend = false,
        holdSend = false,
        calls = 0;
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        release = resolve;
      });
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith('https://api.surge.app/')) {
          calls++;
          if (holdSend) {
            entered();
            await resumed;
          }
          if (throwSend) throw new Error('synthetic transport failure');
          return new Response(
            JSON.stringify(rejectSend ? { error: 'fixture rejected' } : { id: 'synthetic-sms-id' }),
            { status: rejectSend ? 503 : 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return originalFetch(input, init);
      };
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      const site = findSite(manifest.siteId)!;
      const first = site.codes.at(-1)!;
      assert(first.phoneChallenge?.deliveryAck === true, 'Initial send accepted by fake transport');
      const suppressed = await postForm(base, pagePath(manifest, '/login/sms'), {});
      assert(suppressed.status === 429, 'Repeated site request must be rate limited');
      assert(Number(suppressed.headers.get('Retry-After')) > 0, 'Retry deadline is required');
      assert(
        calls === 1 && site.codes.length === 1 && !first.consumed,
        'Cooldown must precede send and invalidation'
      );
      rejectSend = true;
      allowNextPhoneRequest(site);
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      const failed = site.codes.at(-1)!;
      assert(calls === 2, 'Both sends exercised actual provider boundary');
      assert(failed.phoneChallenge?.deliveryAck === false, 'Failed send cannot claim acceptance');
      const failurePage = await (
        await fetch(`${base}${pagePath(manifest, '/login/sms/verify')}`)
      ).text();
      assert(
        failurePage.includes('not confirm') && !failurePage.includes('We texted'),
        'Actual failed send needs truthful notice'
      );
      const failureRetry = await postForm(base, pagePath(manifest, '/login/sms'), {});
      assert(failureRetry.status === 429 && calls === 2, 'Failed send must retain cooldown');
      assert(site.codes.at(-1) === failed, 'Failed-send cooldown changed challenge');
      assert(
        (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: failed.code }))
          .status !== 303,
        'Failed replacement remained a valid code'
      );
      assert(
        (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: first.code }))
          .status !== 303,
        'Failed resend revived stale prior code'
      );
      rejectSend = false;
      throwSend = true;
      allowNextPhoneRequest(site);
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      const thrown = site.codes.at(-1)!;
      assert(
        (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: thrown.code }))
          .status !== 303,
        'Thrown transport activated replacement'
      );
      throwSend = false;
      holdSend = true;
      allowNextPhoneRequest(site);
      const delayed = postForm(base, pagePath(manifest, '/login/sms'), {});
      await held;
      const pending = site.codes.at(-1)!;
      try {
        assert(
          (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: pending.code }))
            .status !== 303,
          'Pending unacknowledged code authenticated'
        );
        const callsBeforeRetry = calls;
        const pendingRetry = await postForm(base, pagePath(manifest, '/login/sms'), {});
        assert(
          pendingRetry.status === 429 && calls === callsBeforeRetry,
          'Held send must reserve cooldown before IO'
        );
        assert(site.codes.at(-1) === pending, 'Held send cooldown replaced current challenge');
        holdSend = false;
        allowNextPhoneRequest(site);
        await postForm(base, pagePath(manifest, '/login/sms'), {});
      } finally {
        release();
      }
      await delayed;
      const latest = site.codes.at(-1)!;
      assert(latest !== pending, 'Newer challenge exists');
      assert(pending.phoneChallenge?.deliveryAck === true, 'Old send eventually accepted');
      assert(
        (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: pending.code }))
          .status !== 303,
        'Late acknowledgement reactivated superseded code'
      );
      assert(
        pending.phoneChallenge?.consumedAt === null,
        'Invalidation claimed successful consumption'
      );
      assert(
        (await postForm(base, pagePath(manifest, '/login/sms/verify'), { code: latest.code }))
          .status === 303,
        'Newest acknowledged challenge cannot authenticate'
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.iPhoneDevice.deleteMany({ where: { userId } });
    await cleanup(userId);
  }
});

test('phone SMS verification page distinguishes missing and unacknowledged sends without exposing secrets', async () => {
  const userId = await createUser();
  const prior = process.env.CLOUD_IPHONE_ENABLED;
  try {
    process.env.CLOUD_IPHONE_ENABLED = '1';
    await prisma.user.update({
      where: { userId },
      data: { phone: '+19729777432', isAnonymous: false },
    });
    await prisma.iPhoneDevice.create({
      data: { userId, providerDeviceId: `sms-notice-${userId}`, enabled: true },
    });
    await withLocalSite(async ({ base }) => {
      const fixture = await createFixture(base, {
        userId,
        scenario: 'phone_sms_otp',
        publicBaseUrl: base,
      });
      assert(fixture.status === 201, 'Configured fixture');
      const manifest = await fixture.json();
      const absent = await (
        await fetch(`${base}${pagePath(manifest, '/login/sms/verify')}`)
      ).text();
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      const issued = findSite(manifest.siteId)!.codes.at(-1)!;
      issued.phoneChallenge!.deliveryAck = false;
      const failed = await (
        await fetch(`${base}${pagePath(manifest, '/login/sms/verify')}`)
      ).text();
      assert(!failed.includes('We texted'), 'Unacknowledged send claimed a code was texted');
      assert(
        failed.includes('not confirm') && failed.includes('request a new code'),
        'Unacknowledged send needs truthful retry notice'
      );
      assert(
        absent.includes('No sign-in code has been requested'),
        'Missing challenge needs distinct notice'
      );
      assert(
        !failed.includes(issued.code) && !failed.includes('+19729777432'),
        'Notice leaked OTP or full phone'
      );
    });
  } finally {
    if (prior === undefined) delete process.env.CLOUD_IPHONE_ENABLED;
    else process.env.CLOUD_IPHONE_ENABLED = prior;
    await prisma.iPhoneDevice.deleteMany({ where: { userId } });
    await cleanup(userId);
  }
});
