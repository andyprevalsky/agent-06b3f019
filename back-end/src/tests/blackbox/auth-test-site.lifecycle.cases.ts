/**
 * Rose Shop fixture lifecycle: every row a site seeds must be gone after the
 * run, even when the backend never finished creating the site or no longer
 * holds it in memory. A leaked fixture inbox is not scoped to a realm, so it
 * would change the email_otp option of every later run for that benchmark user.
 */
import { prisma } from '../../providers/database';
import { AUTH_TEST_SITE_BASE_PATH, FIXTURE_INBOX_TOKEN } from '../../domains/auth-test-site/config';
import { createAuthTestSite } from '../../domains/auth-test-site/service';
import * as sites from '../../domains/auth-test-site/repoSites';
import {
  API_KEY,
  assert,
  cleanup,
  createFixture,
  createMintedIdentity,
  createUser,
  test,
  withLocalSite,
  type Manifest,
} from './auth-test-site.testkit';

async function fixtureRows(userId: string) {
  const [inboxes, passwords] = await Promise.all([
    prisma.emailIntegrationCredential.count({
      where: { userId, accessToken: FIXTURE_INBOX_TOKEN },
    }),
    prisma.browserPassword.count({ where: { userId } }),
  ]);
  return { inboxes, passwords };
}

async function releaseInboxRows(userId: string) {
  await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
  await prisma.integration.deleteMany({ where: { userId } });
}

test('a fixture whose creation fails after seeding leaves no rows behind', async () => {
  const userId = await createUser('Avery Ross');
  const findMany = prisma.passkeyCredential.findMany;
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      // The inbox and saved logins are written before the auth-options preview,
      // which is the last step; failing it reproduces a 500 with no siteId.
      (prisma.passkeyCredential as unknown as { findMany: typeof findMany }).findMany =
        (async () => {
          throw new Error('blackbox: passkey read failed');
        }) as typeof findMany;
      let failure: unknown;
      try {
        await createAuthTestSite({ userId, scenario: 'email_otp', publicBaseUrl: base });
      } catch (error) {
        failure = error;
      }
      assert(
        failure instanceof Error && failure.message.includes('passkey read failed'),
        `creation must surface the original failure, got ${String(failure)}`
      );
      const left = await fixtureRows(userId);
      assert(
        left.inboxes === 0 && left.passwords === 0,
        `a failed creation must remove what it seeded: ${JSON.stringify(left)}`
      );
    });
  } finally {
    (prisma.passkeyCredential as unknown as { findMany: typeof findMany }).findMany = findMany;
    await releaseInboxRows(userId);
    await cleanup(userId);
  }
});

test('teardown removes a site this backend no longer holds when given its user', async () => {
  const userId = await createUser('Avery Ross');
  const other = await createUser('Other Person');
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      const created = await createFixture(base, {
        userId,
        scenario: 'email_otp',
        publicBaseUrl: base,
      });
      assert(created.status === 201, `fixture expected 201, got ${created.status}`);
      const manifest = (await created.json()) as Manifest;
      const seeded = await fixtureRows(userId);
      assert(
        seeded.inboxes === 1,
        `the fixture inbox must be connected: ${JSON.stringify(seeded)}`
      );
      const url = `${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${manifest.siteId}`;
      const headers = { 'X-API-Key': API_KEY };

      // Eviction, expiry, or a restart: the in-memory record is gone, the rows are not.
      assert(sites.deleteSite(manifest.siteId), 'the site was held in memory');
      const anonymous = await fetch(url, { method: 'DELETE', headers });
      assert(
        anonymous.status === 404,
        `without a user an unknown site is 404, got ${anonymous.status}`
      );
      const foreign = await fetch(`${url}?userId=${encodeURIComponent(other)}`, {
        method: 'DELETE',
        headers,
      });
      assert(foreign.status === 200, `another user's rows are untouched, got ${foreign.status}`);
      assert(
        (await fixtureRows(userId)).inboxes === 1,
        "another user's teardown must not reach these rows"
      );

      const removed = await fetch(`${url}?userId=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers,
      });
      assert(removed.status === 200, `teardown by user expected 200, got ${removed.status}`);
      const left = await fixtureRows(userId);
      assert(
        left.inboxes === 0 && left.passwords === 0,
        `teardown must remove every seeded row: ${JSON.stringify(left)}`
      );

      // A held site still refuses a teardown that names a different user.
      const again = await createFixture(base, {
        userId,
        scenario: 'email_otp',
        publicBaseUrl: base,
      });
      const held = (await again.json()) as Manifest;
      const mismatch = await fetch(
        `${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${held.siteId}?userId=${encodeURIComponent(other)}`,
        { method: 'DELETE', headers }
      );
      assert(mismatch.status === 403, `a held site rejects another user, got ${mismatch.status}`);
      const owned = await fetch(`${base}${AUTH_TEST_SITE_BASE_PATH}/fixtures/${held.siteId}`, {
        method: 'DELETE',
        headers,
      });
      assert(owned.status === 200, 'the held site is torn down as before');
    });
  } finally {
    await releaseInboxRows(userId);
    await cleanup(userId);
    await cleanup(other);
  }
});
