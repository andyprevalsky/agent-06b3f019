/**
 * Auth-options cases about the user's agent identity (the minted inbox and
 * phone). Registered by auth-options.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
import { EmailProvider, IntegrationStatus, IntegrationType } from '@prisma/client';
import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../domains/auth-options/service';

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
    fn: () =>
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
  },
];
