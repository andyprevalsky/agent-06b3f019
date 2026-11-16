/**
 * Synthetic team where one owner has WhatsApp, LinkedIn, Granola, Fireflies and Plaid connected,
 * each with data that must be shareable and same-provider data that must stay private.
 * Shares are NOT created here: the suite creates them through the Teams HTTP API.
 */
import { randomUUID } from 'node:crypto';
import type { MessageChannel } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function seedTeamIntegrationsFixture() {
  const marker = `ROSE-TEAMINT-${randomUUID().slice(0, 8)}`;
  const ids = {
    reader: randomUUID(),
    owner: randomUUID(),
    peer: randomUUID(),
    invited: randomUUID(),
    stranger: randomUUID(),
  };
  type Key = keyof typeof ids;
  const email = (key: Key) => `${marker.toLowerCase()}-${key}@example.test`;
  for (const key of Object.keys(ids) as Key[]) {
    await prisma.user.create({
      data: {
        userId: ids[key],
        email: email(key),
        name: `Integrations ${key}`,
        isAnonymous: false,
      },
    });
  }
  const teams = { atlas: randomUUID(), orbit: randomUUID() };
  const member = (key: Key, role = 'MEMBER', status = 'ACCEPTED') => ({
    userId: ids[key],
    email: email(key),
    role,
    status,
    acceptedAt: status === 'ACCEPTED' ? new Date() : null,
  });
  await prisma.team.create({
    data: {
      id: teams.atlas,
      name: `${marker} Atlas`,
      ownerUserId: ids.reader,
      members: {
        create: [
          member('reader', 'OWNER'),
          member('owner'),
          member('peer'),
          member('invited', 'MEMBER', 'INVITED'),
        ],
      },
    },
  });
  // Both members accepted, nothing shared: team_id must narrow, never widen.
  await prisma.team.create({
    data: {
      id: teams.orbit,
      name: `${marker} Orbit`,
      ownerUserId: ids.owner,
      members: { create: [member('owner', 'OWNER'), member('reader')] },
    },
  });
  const integration = (key: Key, name: string, accountEmail: string | null = null) =>
    prisma.integration.create({
      data: {
        userId: ids[key],
        name,
        accountId: '',
        accountEmail,
        type: 'DATA_SOURCE',
        status: 'CONNECTED',
        isActive: true,
      },
    });
  const owner = {
    whatsapp: await integration('owner', 'whatsapp'),
    linkedin: await integration('owner', 'linkedin'),
    imessage: await integration('owner', 'imessage'),
    granola: await integration('owner', 'granola', 'Owner.Notes@Example.test'),
    fireflies: await integration('owner', 'fireflies', 'owner-calls@example.test'),
    plaid: await integration('owner', 'plaid'),
  };
  const readerPlaid = await integration('reader', 'plaid');
  const person = async (key: Key) =>
    (
      await prisma.person.create({
        data: {
          userId: ids[key],
          firstName: 'Partner',
          lastName: key,
          phoneNumber: '+15550001111',
        },
      })
    ).id;
  const people = { owner: await person('owner'), reader: await person('reader') };
  let second = 0;
  const message = (key: 'owner' | 'reader', channel: MessageChannel, text: string) =>
    prisma.messageRecord.create({
      data: {
        userId: ids[key],
        personId: people[key],
        channel,
        from: '+15550001111',
        to: '+15550002222',
        googleAccountEmail: channel === 'EMAIL' ? email(key) : null,
        message: `${marker} ${text}`,
        // Interleaved in time with the private channels so context windows would expose a leak.
        timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, second++)),
        externalId: randomUUID(),
      },
    });
  await message('owner', 'WHATSAPP', 'SHARED whatsapp one');
  await message('owner', 'IMESSAGE', 'PRIVATE imessage');
  await message('owner', 'WHATSAPP', 'SHARED whatsapp two');
  await message('owner', 'EMAIL', 'PRIVATE email');
  await message('owner', 'LINKEDIN', 'SHARED linkedin one');
  await message('owner', 'LINKEDIN', 'SHARED linkedin two');
  await message('reader', 'WHATSAPP', 'READER whatsapp own');
  const document = (key: 'owner' | 'reader', source: string, text: string) =>
    prisma.userDataDocument.create({
      data: {
        userId: ids[key],
        source,
        externalId: `${marker}-${key}-${source}`,
        title: `${marker} ${text} title`,
        content: `${marker} ${text} body`,
        contentHash: randomUUID(),
        metadata: { provider: source.split('_')[0] },
        sourceUpdatedAt: new Date(Date.UTC(2026, 10, 9, 9, 0, second++)),
      },
    });
  await document('owner', 'granola_note', 'SHARED granola note');
  await document('owner', 'granola_transcript', 'SHARED granola transcript');
  await document('owner', 'fireflies_summary', 'SHARED fireflies summary');
  const privateDoc = await document('owner', 'chatgpt', 'PRIVATE chatgpt export');
  await document('reader', 'granola_note', 'READER granola own');
  await document('reader', 'apple_notes', 'READER apple note own');
  const item = async (key: 'owner' | 'reader', integrationId: string, institution: string) => {
    const row = await prisma.plaidItem.create({
      data: {
        userId: ids[key],
        integrationId,
        plaidItemId: `item-${randomUUID()}`,
        institutionName: institution,
        encryptedAccessToken: 'not-a-real-token',
        status: 'ACTIVE',
      },
    });
    const account = await prisma.plaidAccount.create({
      data: {
        userId: ids[key],
        plaidItemId: row.id,
        plaidAccountId: `acct-${randomUUID()}`,
        name: `${institution} Checking`,
        mask: '4242',
        type: 'depository',
      },
    });
    return { ...row, account };
  };
  const items = {
    shared: await item('owner', owner.plaid.id, 'Atlas Credit Union'),
    private: await item('owner', owner.plaid.id, 'Private Bank'),
    reader: await item('reader', readerPlaid.id, 'Reader Bank'),
  };
  const transaction = (
    key: 'owner' | 'reader',
    target: (typeof items)[keyof typeof items],
    text: string,
    amount: string,
    direction: 'OUTFLOW' | 'INFLOW' = 'OUTFLOW'
  ) =>
    prisma.plaidTransaction.create({
      data: {
        userId: ids[key],
        plaidItemId: target.id,
        plaidAccountId: target.account.id,
        plaidTransactionId: `tx-${randomUUID()}`,
        plaidAccountExternalId: target.account.plaidAccountId,
        date: new Date(Date.UTC(2026, 10, 1 + (second++ % 20))),
        name: `${marker} ${text}`,
        amount: direction === 'OUTFLOW' ? amount : `-${amount}`,
        absoluteAmount: amount,
        direction,
        isoCurrencyCode: 'USD',
        pending: false,
      },
    });
  await transaction('owner', items.shared, 'SHARED plaid coffee', '5.00');
  await transaction('owner', items.shared, 'SHARED plaid payroll', '100.00', 'INFLOW');
  await transaction('owner', items.private, 'PRIVATE plaid rent', '900.00');
  await transaction('reader', items.reader, 'READER plaid lunch', '12.00');
  return {
    marker,
    ids,
    teams,
    owner,
    readerPlaid,
    items,
    people,
    privateDocExternalId: privateDoc.externalId,
  };
}
export type TeamIntegrationsFixture = Awaited<ReturnType<typeof seedTeamIntegrationsFixture>>;

export async function cleanupTeamIntegrationsFixture(f: TeamIntegrationsFixture) {
  const userIds = Object.values(f.ids);
  await prisma.team.deleteMany({ where: { id: { in: Object.values(f.teams) } } });
  await prisma.userDataDocument.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.messageRecord.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.person.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.integration.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
}
