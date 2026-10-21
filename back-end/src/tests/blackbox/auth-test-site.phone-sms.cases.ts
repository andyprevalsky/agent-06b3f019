/** Real routes and issuer state, no outbound transport credentials or live messages. */
import { prisma } from '../../providers/database';
import { findSite } from '../../domains/auth-test-site/service';
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
      await postForm(base, pagePath(manifest, '/login/sms'), {});
      assert(first.consumed, 'Resend invalidates previous challenge');
      const newest = site.codes.at(-1)!;
      const denied = await postForm(base, pagePath(manifest, '/login/sms/verify'), {
        code: first.code,
      });
      assert(denied.status !== 303, 'Old code cannot sign in');
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
