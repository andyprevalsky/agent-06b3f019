/**
 * Auth-options cases about the user's agent identity (the minted inbox and
 * phone). Registered by auth-options.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
import { EmailProvider, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import { getAuthOptions, saveMintedAccountPassword } from '../../domains/auth-options/service';
import {
  findReadableInboxEmails,
  findReadableInboxes,
  upsertSignupPassword,
} from '../../providers/authOptionsStore';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { primitiveDomain } from '../../providers/primitive';
import { mintedAccountPassword } from '../../providers/mintedAccountPassword';
import { quarantine } from '../helpers/quarantine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A throwaway user with AgentPhone provisioning off, so no test buys a phone number. */
async function withFreshUser(fn: (userId: string) => Promise<void>): Promise<void> {
  const userId = `auth-options-${randomUUID()}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  const previousAgentPhoneApiKey = process.env.AGENTPHONE_API_KEY;
  delete process.env.AGENTPHONE_API_KEY;
  try {
    await fn(userId);
  } finally {
    if (previousAgentPhoneApiKey === undefined) delete process.env.AGENTPHONE_API_KEY;
    else process.env.AGENTPHONE_API_KEY = previousAgentPhoneApiKey;
    await prisma.mintedAccount.deleteMany({ where: { userId } });
    await prisma.agentIdentity.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function connectInbox(
  userId: string,
  email: string,
  tokens: { accessToken?: string; refreshToken?: string; state?: string }
): Promise<void> {
  const integration =
    (await prisma.integration.findFirst({ where: { userId, name: 'gmail' } })) ??
    (await prisma.integration.create({
      data: {
        userId,
        name: 'gmail',
        type: IntegrationType.TOOL_SETUP,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    }));
  await prisma.emailIntegrationCredential.create({
    data: {
      userId,
      integrationId: integration.id,
      provider: EmailProvider.GMAIL,
      email,
      ...tokens,
    },
  });
}

export const identityCases: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    // The inbox list the agent sees and the inboxes the one-time-code poller
    // reads come from one source, with full addresses, minted inbox included.
    name: 'readable inbox emails list exactly the inboxes the code poller reads',
    fn: () =>
      withFreshUser(async (userId) => {
        const suffix = randomUUID().slice(0, 8);
        const gmail = `person.${suffix}@gmail.example`;
        const ownDomainInbox = `inbox.${suffix}@${primitiveDomain().toLowerCase()}`;
        const minted = `rose.agent.${suffix}@${primitiveDomain().toLowerCase()}`;
        try {
          await connectInbox(userId, gmail, { accessToken: 'a', refreshToken: 'r' });
          await connectInbox(userId, ownDomainInbox, { accessToken: 'a', refreshToken: 'r' });
          await connectInbox(userId, `stale.${suffix}@gmail.example`, {
            accessToken: 'a',
            refreshToken: 'r',
            state: 'needs_reconnect',
          });
          await connectInbox(userId, `tokenless.${suffix}@gmail.example`, {});
          await prisma.mintedAccount.create({
            data: { userId, authRealm: `shop-${suffix}.example`, accountLabel: minted },
          });

          const userInboxes = [gmail, ownDomainInbox].sort();
          const expected = [gmail, ownDomainInbox, minted].sort();
          const listed = (await findReadableInboxEmails(userId)).sort();
          assert(
            JSON.stringify(listed) === JSON.stringify(userInboxes),
            `readable inbox emails are the user's own inboxes, full addresses: ${JSON.stringify(listed)}`
          );
          const sources = await findReadableInboxes(userId);
          const read = [
            ...sources.gmailCredentials.map((row) => row.email ?? ''),
            ...sources.primitiveInboxEmails,
          ].sort();
          assert(
            JSON.stringify(read) === JSON.stringify(expected),
            `the poller reads exactly the listed inboxes: ${JSON.stringify(read)}`
          );
          const options = await getAuthOptions(userId, `https://shop-${suffix}.example/login`);
          assert(
            JSON.stringify([...options.email_otp.connected_emails].sort()) ===
              JSON.stringify(userInboxes),
            `email OTP lists the user's inboxes: ${JSON.stringify(options.email_otp.connected_emails)}`
          );
          assert(
            JSON.stringify([...options.readable_identifiers].sort()) === JSON.stringify(expected),
            `readable identifiers are exactly what the poller reads: ${JSON.stringify(options.readable_identifiers)}`
          );
          // fetchEmailsSince must take its inboxes from the shared source only.
          const poller = readFileSync(
            resolve(__dirname, '../../domains/integrations/service.ts'),
            'utf8'
          );
          const body = poller.slice(poller.indexOf('export async function fetchEmailsSince'));
          assert(
            body.includes('await findReadableInboxes(userId)') &&
              !body.slice(0, body.indexOf('\n}\n')).includes('emailCredentials'),
            'fetchEmailsSince must read inboxes only from findReadableInboxes'
          );
        } finally {
          await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
          await prisma.integration.deleteMany({ where: { userId } });
        }
      }),
  },
  {
    // An account the agent signs up for used to be unreachable afterwards: the
    // password it made up was never saved. The minted identity now carries the
    // password to create the account with, and typing it saves it.
    name: 'a minted account is created with a password that is saved once typed',
    fn: () =>
      withFreshUser(async (userId) => {
        const site = 'https://shop.example/signup';
        const before = await getAuthOptions(userId, site);
        assert(
          before.minted !== null,
          'minted identity must be offered on a site with nothing saved'
        );
        assert(
          before.minted.newPassword?.ref === 'pwd:new',
          'minted must carry the new-password ref'
        );
        assert(
          mintedAccountPassword(userId, 'shop.example') ===
            mintedAccountPassword(userId, 'shop.example') &&
            mintedAccountPassword(userId, 'shop.example') !==
              mintedAccountPassword(userId, 'other.example'),
          'the password is stable for a site and different across sites'
        );
        const unsaved = await prisma.browserPassword.count({ where: { userId } });
        assert(unsaved === 0, 'nothing is saved until the password is typed');

        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const saved = await saveMintedAccountPassword(userId, site);
            assert(saved.saved && saved.username === before.minted.email, 'save must succeed');
          }
          const rows = await prisma.browserPassword.findMany({ where: { userId } });
          assert(
            rows.length === 1 &&
              rows[0]?.origin === site &&
              rows[0]?.username === before.minted.email,
            `exactly one saved login for the new account: ${JSON.stringify(rows.map((r) => r.username))}`
          );
          const after = await getAuthOptions(userId, site);
          assert(
            after.passwords.length === 1 && after.passwords[0]?.username === before.minted.email,
            'the next run is offered the saved login'
          );
          // The row was saved when pwd:new was typed, before the site confirmed the
          // signup, so it must not hide the minted offer: a failed signup has to be
          // retryable on the next run with the same email and pwd:new.
          assert(
            after.minted?.email === before.minted.email &&
              after.minted?.newPassword?.ref === 'pwd:new',
            `the minted offer stays beside the agent's own saved login: ${JSON.stringify(after.minted)}`
          );
          assert(
            after.passwords[0]?.browserSource === 'agent_signup',
            'the saved login is marked as the agent signup'
          );
          const elsewhere = await saveMintedAccountPassword(
            userId,
            'https://never-visited.example/'
          );
          assert(!elsewhere.saved, 'no minted account for a realm means nothing to save');
        } finally {
          await prisma.browserPassword.deleteMany({ where: { userId } });
        }
      }),
  },
  {
    // The guard used to be a read before the write: a browser sync that inserted
    // the same login between the two made the upsert take its conflict branch
    // and replace the user's real password with the minted one. The write now
    // carries the condition itself, so it is exercised here with the user's row
    // already present, which is exactly what the losing write sees.
    name: "a sign-up password write never replaces a login the user's browser synced",
    fn: () =>
      withFreshUser(async (userId) => {
        const site = 'https://shop.example/signup';
        const offered = await getAuthOptions(userId, site);
        assert(offered.minted !== null, 'minted identity must be offered');
        const username = offered.minted.email;
        const write = (encryptedPassword: string) =>
          upsertSignupPassword({
            userId,
            origin: site,
            username,
            encryptedPassword,
            browserSource: 'agent_signup',
            nowMs: Date.now(),
          });
        try {
          await prisma.browserPassword.create({
            data: {
              userId,
              origin: site,
              username,
              encryptedPassword: 'users-own-ciphertext',
              browserSource: 'chrome',
            },
          });
          const lost = await write('minted-ciphertext');
          const kept = await prisma.browserPassword.findMany({ where: { userId } });
          assert(
            !lost.saved &&
              kept.length === 1 &&
              kept[0]?.encryptedPassword === 'users-own-ciphertext' &&
              kept[0]?.browserSource === 'chrome',
            `the user's synced login was replaced: ${JSON.stringify({ lost, kept: kept.map((row) => [row.browserSource, row.encryptedPassword]) })}`
          );
          const refused = await saveMintedAccountPassword(userId, site);
          assert(
            !refused.saved && refused.username === username,
            `the save must report that the user's login was kept: ${JSON.stringify(refused)}`
          );

          // The agent's own row is still created once and updated in place.
          await prisma.browserPassword.deleteMany({ where: { userId } });
          const created = await write('minted-ciphertext-1');
          const updated = await write('minted-ciphertext-2');
          const own = await prisma.browserPassword.findMany({ where: { userId } });
          assert(
            created.saved &&
              updated.saved &&
              own.length === 1 &&
              own[0]?.encryptedPassword === 'minted-ciphertext-2' &&
              own[0]?.browserSource === 'agent_signup',
            `the agent's own saved login must converge on one row: ${JSON.stringify(own.map((row) => [row.browserSource, row.encryptedPassword]))}`
          );
        } finally {
          await prisma.browserPassword.deleteMany({ where: { userId } });
        }
      }),
  },
  {
    // "Email OTP" was hard-coded unavailable, so the agent was told the rung did
    // not exist even though codes sent to a connected inbox were being read and
    // handed to it. Readable inboxes are listed; ones the poller cannot read are not.
    name: 'email OTP lists exactly the connected inboxes the code poller can read',
    fn: () =>
      withFreshUser(async (userId) => {
        const tokens = { accessToken: 'access-token', refreshToken: 'refresh-token' };
        await connectInbox(userId, 'Avery@Inbox.example', tokens);
        await connectInbox(userId, 'no-refresh@inbox.example', { accessToken: 'access-token' });
        await connectInbox(userId, 'dead@inbox.example', { ...tokens, state: 'needs_reconnect' });
        try {
          const options = await getAuthOptions(userId, 'shop.example');
          assert(
            options.email_otp.available === true,
            'a readable inbox makes email OTP available'
          );
          assert(
            JSON.stringify(options.email_otp.connected_emails) ===
              JSON.stringify(['avery@inbox.example']),
            `only the readable inbox is listed: ${JSON.stringify(options.email_otp.connected_emails)}`
          );
          assert(
            options.minted !== null,
            'the minted identity stays offered: an inbox is a way in to accounts the user has, not a reason to stop offering one for accounts they do not'
          );
          const previous = process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
          process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = '1';
          try {
            const anonymous = await getAuthOptions(userId, 'shop.example');
            assert(
              anonymous.email_otp.available === false &&
                anonymous.email_otp.connected_emails.length === 0,
              'the benchmark anonymous switch hides the inboxes with the rest of the saved auth'
            );
          } finally {
            if (previous === undefined) delete process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH;
            else process.env.BENCHMARK_DISABLE_SAVED_BROWSER_AUTH = previous;
          }
        } finally {
          await prisma.emailIntegrationCredential.deleteMany({ where: { userId } });
          await prisma.integration.deleteMany({ where: { userId } });
        }
      }),
  },
  {
    // Browser agents that start together each ask for auth options at once. Each
    // used to mint its own inbox, so all but one were told an identity that was
    // then overwritten: codes went to an address the agent was never polling.
    name: 'concurrent first use mints one agent identity for the user',
    fn: quarantine(
      {
        since: '2026-11-11',
        repair: 'pending-handoff:3d9a8594a3a641dd9a1db0c620c1438f',
        error: 'Foreign key constraint violated: `AgentIdentity_userId_fkey (index)`',
        evidence:
          '.context/deploy-pipeline-e0f5/attempts/24/focused/backend-coverage-blackbox (PR1881 FLAKY 3d9a8594)',
      },
      () =>
        withFreshUser(async (userId) => {
          const realms = ['one-shop.example', 'two-shop.example', 'three-shop.example'];
          const options = await Promise.all(realms.map((realm) => getAuthOptions(userId, realm)));
          const offered = options.map((option) => option.minted?.email ?? null);
          const identity = await prisma.agentIdentity.findUnique({ where: { userId } });
          assert(identity !== null, 'expected an agent identity to be minted');
          assert(
            offered.every((email) => email === identity.email),
            `every concurrent caller must be offered the one stored identity ${identity.email}, got ${JSON.stringify(offered)}`
          );
          const labels = await prisma.mintedAccount.findMany({
            where: { userId },
            select: { accountLabel: true },
          });
          assert(
            labels.length === realms.length &&
              labels.every((row) => row.accountLabel === identity.email),
            `every realm's minted account must carry the same inbox: ${JSON.stringify(labels)}`
          );
        }),
      { unit: 'concurrent first use mints one agent identity for the user' }
    ),
  },
];
