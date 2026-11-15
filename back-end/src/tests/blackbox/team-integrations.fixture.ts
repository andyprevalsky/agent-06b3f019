/**
 * Team-shared WhatsApp, LinkedIn, Granola, Fireflies and Plaid on isolated synthetic owners
 * (docs/plans/active/share-all-integrations.md). Every row a teammate's agent may read is owned by
 * a synthetic owner, never by the reader, so the bench user's real single-account rows never collide.
 * Grants use the stored shapes: '' for WhatsApp/LinkedIn, '' plus the pinned account email for
 * meeting notes, and the PlaidItem id for one bank login.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

export const TEAM_INTEGRATIONS_MARKER = 'ROSE-TEAM-SHARED';
/** Values a teammate's agent must find (shared) or must never see (private). */
export const TEAM_INTEGRATIONS_EXPECTED = {
  whatsappCode: 'ORCHID-41',
  linkedinCode: 'CEDAR-77',
  granolaCode: 'HARBOR-12',
  sharedBank: { institution: 'Lighthouse Credit Union', transactions: 4, total: '1134.60' },
  privateValues: ['EMBER-93', 'GLACIER-58', 'Juniper Private Bank', '6565.50'],
} as const;

const SHARED_TRANSACTIONS: Array<[string, string, string]> = [
  ['2026-11-03', 'catering for team offsite', '212.40'],
  ['2026-11-05', 'design contractor', '489.15'],
  ['2026-11-07', 'coworking day passes', '76.30'],
  ['2026-11-09', 'cloud hosting', '356.75'],
];
const PRIVATE_TRANSACTIONS: Array<[string, string, string]> = [
  ['2026-11-04', 'PRIVATE payroll transfer', '4200.00'],
  ['2026-11-06', 'PRIVATE tuition payment', '1750.00'],
  ['2026-11-08', 'PRIVATE medical bill', '615.50'],
];
const SYNTHETIC_KEYS = ['owner', 'outsider'] as const;
type UserKey = 'reader' | (typeof SYNTHETIC_KEYS)[number];

const fixtureEmail = (marker: string, key: UserKey, id: string) =>
  `${marker.toLowerCase()}-${key}-${id}@example.test`;

async function deleteOwners(userIds: string[]) {
  if (userIds.length === 0) return;
  // Integration and Person carry no User relation; users cascade teams, members and documents.
  await prisma.integration.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.person.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { userId: { in: userIds } } });
}

/** Removes an earlier seed of `marker` so a retried attempt keeps the exact expected counts. */
export async function cleanupTeamIntegrationsMarker(marker = TEAM_INTEGRATIONS_MARKER) {
  const prior = await prisma.user.findMany({
    where: {
      OR: SYNTHETIC_KEYS.map((key) => ({
        email: { startsWith: `${marker.toLowerCase()}-${key}-`, endsWith: '@example.test' },
      })),
    },
    select: { userId: true },
  });
  await deleteOwners(prior.map((user) => user.userId));
}

export async function seedTeamIntegrationsFixture(
  readerId: string = randomUUID(),
  marker = TEAM_INTEGRATIONS_MARKER
) {
  await cleanupTeamIntegrationsMarker(marker);
  const createdReader = !(await prisma.user.findUnique({ where: { userId: readerId } }));
  const ids: Record<UserKey, string> = {
    reader: readerId,
    owner: randomUUID(),
    outsider: randomUUID(),
  };
  const emails = Object.fromEntries(
    (Object.keys(ids) as UserKey[]).map((key) => [key, fixtureEmail(marker, key, ids[key])])
  ) as Record<UserKey, string>;
  for (const key of Object.keys(ids) as UserKey[]) {
    await prisma.user.upsert({
      where: { userId: ids[key] },
      update: {},
      create: { userId: ids[key], email: emails[key], name: `Team integrations ${key}` },
    });
  }
  const teams = { shared: randomUUID(), unrelated: randomUUID() };
  const member = (key: UserKey, owner = false) => ({
    userId: ids[key],
    email: emails[key],
    role: owner ? 'OWNER' : 'MEMBER',
    status: 'ACCEPTED',
    acceptedAt: new Date(),
  });
  await prisma.team.create({
    data: {
      id: teams.shared,
      name: `${marker} Lighthouse`,
      ownerUserId: ids.owner,
      members: { create: [member('owner', true), member('reader')] },
    },
  });
  await prisma.team.create({
    data: {
      id: teams.unrelated,
      name: `${marker} Unrelated`,
      ownerUserId: ids.outsider,
      members: { create: [member('outsider', true), member('owner')] },
    },
  });

  const connect = (key: UserKey, name: string, accountEmail: string | null = null) =>
    prisma.integration.create({
      data: {
        userId: ids[key],
        name,
        accountEmail,
        type: 'DATA_SOURCE',
        status: 'CONNECTED',
        isActive: true,
      },
    });
  const meetingEmail = (provider: string) =>
    `${marker.toLowerCase()}-${provider}-${ids.owner}@example.test`;
  const integrations = {
    whatsapp: (await connect('owner', 'whatsapp')).id,
    linkedin: (await connect('owner', 'linkedin')).id,
    granola: (await connect('owner', 'granola', meetingEmail('granola'))).id,
    fireflies: (await connect('owner', 'fireflies', meetingEmail('fireflies'))).id,
    plaid: (await connect('owner', 'plaid')).id,
    outsiderWhatsapp: (await connect('outsider', 'whatsapp')).id,
  };

  const people = {
    owner: (
      await prisma.person.create({
        data: { userId: ids.owner, firstName: 'Shared', lastName: 'Contact' },
      })
    ).id,
    outsider: (
      await prisma.person.create({
        data: { userId: ids.outsider, firstName: 'Outside', lastName: 'Contact' },
      })
    ).id,
  };
  let sequence = 0;
  const message = (key: 'owner' | 'outsider', channel: 'WHATSAPP' | 'LINKEDIN', text: string) =>
    prisma.messageRecord.create({
      data: {
        userId: ids[key],
        personId: people[key],
        channel,
        from: channel === 'WHATSAPP' ? '+15550100041' : 'Shared Contact',
        to: 'me',
        message: `${marker} ${text}`,
        timestamp: new Date(Date.UTC(2026, 10, 10, 15, 0, sequence++)),
        externalId: randomUUID(),
      },
    });
  const codes = TEAM_INTEGRATIONS_EXPECTED;
  await message('owner', 'WHATSAPP', `WhatsApp: the launch code word is ${codes.whatsappCode}.`);
  await message('owner', 'WHATSAPP', 'WhatsApp: bring the demo laptop to the offsite.');
  await message('owner', 'LINKEDIN', `LinkedIn: the partner code word is ${codes.linkedinCode}.`);
  await message('outsider', 'WHATSAPP', 'PRIVATE outsider WhatsApp: the code word is GLACIER-58.');

  const meeting = async (provider: 'granola' | 'fireflies', title: string, body: string) => {
    const label = provider === 'granola' ? 'Granola' : 'Fireflies';
    const meetingId = `${marker}-${provider}-${randomUUID()}`;
    const meetingTime = '2026-11-10T16:00:00.000Z';
    for (const kind of provider === 'granola' ? ['note', 'summary'] : ['note', 'transcript']) {
      const content = `# ${marker} ${title}\n\n${label} meeting: ${meetingId}\n\n${marker} ${body}`;
      await prisma.userDataDocument.create({
        data: {
          userId: ids.owner,
          source: `${provider}_${kind}`,
          externalId: meetingId,
          title: `${marker} ${title}`,
          content,
          metadata: { provider, meetingId, meetingTime, kind },
          contentHash: `${provider}-${kind}-${meetingId}`,
          sourceUpdatedAt: new Date(meetingTime),
        },
      });
    }
  };
  await meeting(
    'granola',
    'Roadmap sync',
    `Granola note: the roadmap code word is ${codes.granolaCode}.`
  );
  await meeting('fireflies', 'Board prep', 'Fireflies PRIVATE: the board code word is EMBER-93.');

  const bank = async (
    institutionName: string,
    accountName: string,
    mask: string,
    rows: Array<[string, string, string]>
  ) => {
    const tag = `${marker}-${randomUUID()}`;
    const item = await prisma.plaidItem.create({
      data: {
        userId: ids.owner,
        integrationId: integrations.plaid,
        plaidItemId: `${tag}-item`,
        plaidInstitutionId: `${tag}-institution`,
        institutionName,
        encryptedAccessToken: 'REDACTED_TEAM_FIXTURE',
        status: 'ACTIVE',
        products: ['transactions'],
        lastSyncAt: new Date(),
      },
    });
    const account = await prisma.plaidAccount.create({
      data: {
        userId: ids.owner,
        plaidItemId: item.id,
        plaidAccountId: `${tag}-account`,
        name: accountName,
        mask,
        type: 'depository',
        subtype: 'checking',
      },
    });
    for (const [index, [date, name, amount]] of rows.entries()) {
      await prisma.plaidTransaction.create({
        data: {
          userId: ids.owner,
          plaidItemId: item.id,
          plaidAccountId: account.id,
          plaidTransactionId: `${tag}-txn-${index}`,
          plaidAccountExternalId: account.plaidAccountId,
          date: new Date(`${date}T00:00:00.000Z`),
          name: `${marker} ${name}`,
          merchantName: `${marker} ${name}`,
          amount,
          absoluteAmount: amount,
          direction: 'OUTFLOW',
          isoCurrencyCode: 'USD',
          category: ['Team fixture'],
          paymentChannel: 'online',
          pending: false,
        },
      });
    }
    return item.id;
  };
  const plaidItems = {
    shared: await bank(codes.sharedBank.institution, 'Team Operating', '4141', SHARED_TRANSACTIONS),
    private: await bank('Juniper Private Bank', 'Personal Savings', '9090', PRIVATE_TRANSACTIONS),
  };

  const share = (
    teamId: string,
    ownerKey: 'owner' | 'outsider',
    integrationId: string,
    provider: string,
    accountId = '',
    accountEmail: string | null = null
  ) =>
    prisma.teamIntegrationShare.create({
      data: {
        teamId,
        integrationId,
        ownerUserId: ids[ownerKey],
        provider,
        accountId,
        accountEmail,
      },
    });
  await share(teams.shared, 'owner', integrations.whatsapp, 'whatsapp');
  await share(teams.shared, 'owner', integrations.linkedin, 'linkedin');
  await share(teams.shared, 'owner', integrations.granola, 'granola', '', meetingEmail('granola'));
  await share(teams.shared, 'owner', integrations.plaid, 'plaid', plaidItems.shared);
  // Fireflies and the private bank stay unshared; the outsider's WhatsApp reaches only a team the
  // reader is not in, so transitive membership must not grant it.
  await share(teams.unrelated, 'outsider', integrations.outsiderWhatsapp, 'whatsapp');

  return { marker, ids, emails, teams, integrations, plaidItems, createdReader };
}

export type TeamIntegrationsFixture = Awaited<ReturnType<typeof seedTeamIntegrationsFixture>>;

/** The exact ids and values a benchmark judge and the fixture runner report. */
export function teamIntegrationsExpectation(fixture: TeamIntegrationsFixture) {
  const expected = TEAM_INTEGRATIONS_EXPECTED;
  return {
    teams: fixture.teams,
    owner_user_id: fixture.ids.owner,
    accounts: {
      whatsapp: 'whatsapp',
      linkedin: 'linkedin',
      granola: 'granola',
      plaid: fixture.plaidItems.shared,
    },
    expected: {
      whatsapp_code: expected.whatsappCode,
      linkedin_code: expected.linkedinCode,
      granola_code: expected.granolaCode,
      shared_bank: expected.sharedBank,
      fireflies_readable: false,
      private_bank_readable: false,
    },
    private_values: expected.privateValues,
  };
}

export async function cleanupTeamIntegrationsFixture(fixture: TeamIntegrationsFixture) {
  await deleteOwners([
    fixture.ids.owner,
    fixture.ids.outsider,
    ...(fixture.createdReader ? [fixture.ids.reader] : []),
  ]);
}
