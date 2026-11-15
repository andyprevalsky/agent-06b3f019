/**
 * Team-shared WhatsApp, LinkedIn, Granola, Fireflies, Plaid, a GitHub repo and an MCP server on isolated synthetic
 * owners (docs/plans/completed/share-all-integrations.md). Every row a teammate's agent may read is owned
 * by a synthetic owner, never by the reader, so the bench user's real single-account rows never
 * collide. Grants use the stored shapes: '' for WhatsApp/LinkedIn, '' plus the pinned account email
 * for meeting notes, the PlaidItem id for one bank login and the canonical ref for a repo.
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import {
  GITHUB_REPO_INTEGRATION_NAME,
  githubRepoIdentity,
  type GithubRepoIdentity,
} from '../../providers/githubRepos/refs';
import {
  connectGithubRepo,
  findGithubRepoConnection,
  grantGithubRepoAccess,
  type GithubRepoConnectionRecord,
} from '../../providers/githubRepos/store';
import { connectMcpServer } from '../../providers/mcp/servers';

export const TEAM_INTEGRATIONS_MARKER = 'ROSE-TEAM-SHARED';
/** Values a teammate's agent must find (shared) or must never see (private). */
export const TEAM_INTEGRATIONS_EXPECTED = {
  whatsappCode: 'ORCHID-41',
  linkedinCode: 'CEDAR-77',
  granolaCode: 'HARBOR-12',
  sharedBank: { institution: 'Lighthouse Credit Union', transactions: 4, total: '1134.60' },
  privateValues: ['EMBER-93', 'GLACIER-58', 'Juniper Private Bank', '6565.50'],
} as const;

export const TEAM_REPO_MARKER = 'ROSE-TEAM-REPO';
/** octocat/Hello-World is public and unchanged since 2012-03-06, so its facts are stable. */
export const TEAM_REPO_EXPECTED = {
  repoUrl: 'https://github.com/octocat/Hello-World',
  defaultBranch: 'master',
  readmeFirstLine: 'Hello World!',
  headCommit: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d',
  /** The outsider's repo, shared only with a team the reader is not in. */
  unsharedRepoUrl: 'https://github.com/octocat/Spoon-Knife',
  privateValues: ['SECRET_REPO_FOLDER_DO_NOT_EXPOSE', 'gh:octocat/spoon-knife'],
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
  // Integration, Person and GithubRepoAccess carry no User relation; users cascade teams, members,
  // folders and documents, and integrations cascade repo connections, Plaid rows and shares.
  await prisma.integration.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.person.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.githubRepoAccess.deleteMany({ where: { userId: { in: userIds } } });
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

/** The reader plus fresh synthetic owner and outsider users, after removing an earlier seed. */
async function fixtureUsers(marker: string, readerId: string) {
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
  const member = (key: UserKey, owner = false) => ({
    userId: ids[key],
    email: emails[key],
    role: owner ? 'OWNER' : 'MEMBER',
    status: 'ACCEPTED',
    acceptedAt: new Date(),
  });
  return { ids, emails, createdReader, member };
}

export async function seedTeamIntegrationsFixture(
  readerId: string = randomUUID(),
  marker = TEAM_INTEGRATIONS_MARKER
) {
  const { ids, emails, createdReader, member } = await fixtureUsers(marker, readerId);
  const teams = { shared: randomUUID(), unrelated: randomUUID() };
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

export async function cleanupTeamIntegrationsFixture(fixture: {
  ids: Record<UserKey, string>;
  createdReader: boolean;
}) {
  await deleteOwners([
    fixture.ids.owner,
    fixture.ids.outsider,
    ...(fixture.createdReader ? [fixture.ids.reader] : []),
  ]);
}

const repoIdentity = (url: string): GithubRepoIdentity => {
  const identity = githubRepoIdentity(url);
  if (identity === null) throw new Error(`Not a GitHub repo URL: ${url}`);
  return identity;
};

/**
 * A teammate's connected public repo shared with the reader's team. The owner connected it through a
 * folder whose startup script must never reach the reader's code session; the outsider's repo is
 * shared only with a team the reader is not in. Clone access is the owner's GithubRepoAccess grant.
 */
export async function seedTeamRepoFixture(
  readerId: string = randomUUID(),
  marker = TEAM_REPO_MARKER
) {
  const expected = TEAM_REPO_EXPECTED;
  const shared = repoIdentity(expected.repoUrl);
  // The reader's own connection would win over the share, so the run would prove nothing about it.
  if ((await findGithubRepoConnection(readerId, shared.canonicalRef)) !== null)
    throw new Error(
      `Reader ${readerId} already connects ${shared.canonicalRef}; the shared-repo fixture needs a reader without it`
    );
  const { ids, emails, createdReader, member } = await fixtureUsers(marker, readerId);
  const teams = { shared: randomUUID(), unrelated: randomUUID() };
  await prisma.team.create({
    data: {
      id: teams.shared,
      name: `${marker} Builders`,
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
  const folder = await prisma.project.create({
    data: {
      userId: ids.owner,
      name: `${marker} Owner folder`,
      repoUrl: shared.repoUrl,
      defaultBranch: expected.defaultBranch,
      syncSalt: randomUUID(),
      startupScript: `echo ${expected.privateValues[0]}`,
    },
  });
  const connect = async (
    key: 'owner' | 'outsider',
    identity: GithubRepoIdentity,
    defaultBranch: string,
    folderId: string | null
  ) => {
    const connection = await connectGithubRepo({
      userId: ids[key],
      identity,
      defaultBranch,
      connectedRoseProjectRef: folderId,
      source: 'connect',
    });
    await grantGithubRepoAccess(ids[key], identity.repoUrl);
    return connection;
  };
  const repo = await connect('owner', shared, expected.defaultBranch, folder.id);
  const outsiderRepo = await connect(
    'outsider',
    repoIdentity(expected.unsharedRepoUrl),
    'main',
    null
  );
  const share = (teamId: string, ownerKey: 'owner' | 'outsider', row: GithubRepoConnectionRecord) =>
    prisma.teamIntegrationShare.create({
      data: {
        teamId,
        integrationId: row.integrationId,
        ownerUserId: ids[ownerKey],
        provider: GITHUB_REPO_INTEGRATION_NAME,
        accountId: row.canonicalRef,
      },
    });
  await share(teams.shared, 'owner', repo);
  await share(teams.unrelated, 'outsider', outsiderRepo);
  return {
    marker,
    ids,
    emails,
    teams,
    repo: {
      canonicalRef: repo.canonicalRef,
      repoUrl: repo.repoUrl,
      integrationId: repo.integrationId,
    },
    folderId: folder.id,
    createdReader,
  };
}

export type TeamRepoFixture = Awaited<ReturnType<typeof seedTeamRepoFixture>>;

/** The exact repo and facts a benchmark judge and the fixture runner report. */
export function teamRepoExpectation(fixture: TeamRepoFixture) {
  const expected = TEAM_REPO_EXPECTED;
  return {
    teams: fixture.teams,
    owner_user_id: fixture.ids.owner,
    repo: {
      github_repo_ref: fixture.repo.canonicalRef,
      repo_url: fixture.repo.repoUrl,
      default_branch: expected.defaultBranch,
    },
    expected: { readme_first_line: expected.readmeFirstLine, head_commit: expected.headCommit },
    private_values: expected.privateValues,
  };
}

export const TEAM_MCP_MARKER = 'ROSE-TEAM-MCP';
/** Context7 is public and needs no sign-in; the owner's connection is probed live at seed time. */
export const TEAM_MCP_EXPECTED = {
  url: 'https://mcp.context7.com/mcp',
  tool: 'resolve-library-id',
  library: 'react',
  privateValues: ['ROSE-TEAM-MCP Private Tools', 'tools.private.example.test'],
} as const;

/**
 * A teammate's (owner's) live Context7 MCP server shared with the reader's team, and an
 * outsider's server shared only with an unrelated team. The reader has no MCP server of
 * its own, so any MCP tool its code agent calls can only come through the share.
 */
export async function seedTeamMcpFixture(
  readerId: string = randomUUID(),
  marker = TEAM_MCP_MARKER
) {
  const expected = TEAM_MCP_EXPECTED;
  if ((await prisma.integration.count({ where: { userId: readerId, name: 'mcp' } })) > 0)
    throw new Error(
      `Reader ${readerId} already connects an MCP server; the shared-MCP fixture needs a reader without one`
    );
  const { ids, emails, createdReader, member } = await fixtureUsers(marker, readerId);
  const teams = { shared: randomUUID(), unrelated: randomUUID() };
  await prisma.team.create({
    data: {
      id: teams.shared,
      name: `${marker} Builders`,
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
  const { server } = await connectMcpServer(ids.owner, {
    url: expected.url,
    name: `${marker} Docs`,
    redirectUri: 'https://www.roselabs.ai/integrations/mcp/callback',
  });
  if (server.status !== 'connected' || !server.tools.some((tool) => tool.name === expected.tool))
    throw new Error(`Context7 did not connect with ${expected.tool}: ${JSON.stringify(server)}`);
  const privateUrl = `https://${expected.privateValues[1]}/mcp`;
  const outsider = await prisma.integration.create({
    data: {
      userId: ids.outsider,
      name: 'mcp',
      type: 'TOOL_SETUP',
      accountId: privateUrl,
      status: 'CONNECTED',
      isActive: true,
      config: {
        kind: 'mcp-server-v1',
        name: expected.privateValues[0],
        slug: 'rose-team-mcp-private',
        url: privateUrl,
        auth: 'none',
        tools: [{ name: 'private_lookup', description: 'Never shared with the reader' }],
      },
    },
  });
  const share = (
    teamId: string,
    ownerKey: 'owner' | 'outsider',
    integrationId: string,
    url: string
  ) =>
    prisma.teamIntegrationShare.create({
      data: { teamId, integrationId, ownerUserId: ids[ownerKey], provider: 'mcp', accountId: url },
    });
  await share(teams.shared, 'owner', server.id, expected.url);
  await share(teams.unrelated, 'outsider', outsider.id, privateUrl);
  return {
    marker,
    ids,
    emails,
    teams,
    server: {
      id: server.id,
      name: server.name,
      url: expected.url,
      tools: server.tools.map((t) => t.name),
    },
    createdReader,
  };
}

export type TeamMcpFixture = Awaited<ReturnType<typeof seedTeamMcpFixture>>;

/** The exact shared server and facts a benchmark judge and the fixture runner report. */
export function teamMcpExpectation(fixture: TeamMcpFixture) {
  return {
    teams: fixture.teams,
    owner_user_id: fixture.ids.owner,
    mcp: {
      integration_id: fixture.server.id,
      name: fixture.server.name,
      url: fixture.server.url,
      tools: fixture.server.tools,
    },
    expected: { tool: TEAM_MCP_EXPECTED.tool, library: TEAM_MCP_EXPECTED.library },
    private_values: TEAM_MCP_EXPECTED.privateValues,
  };
}
