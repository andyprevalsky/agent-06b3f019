/**
 * Auth-options cases about the user's agent identity (the minted inbox and
 * phone). Registered by auth-options.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
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

export const identityCases: Array<{ name: string; fn: () => Promise<void> }> = [
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
