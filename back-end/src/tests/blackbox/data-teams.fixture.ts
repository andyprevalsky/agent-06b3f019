/** Deterministic counts on isolated synthetic owners; shared by HTTP and agent benchmarks. */
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';

export const TEAM_BENCH_MARKER = 'ROSE-TEAM-NOV11';
export async function seedTeamDataFixture(readerId = randomUUID(), marker = TEAM_BENCH_MARKER) {
  const createdReader = !(await prisma.user.findUnique({ where: { userId: readerId } }));
  const ids = {
    reader: readerId,
    teammate: randomUUID(),
    orbit: randomUUID(),
    outsider: randomUUID(),
    pending: randomUUID(),
    noTeam: randomUUID(),
  };
  const emails = Object.fromEntries(
    Object.entries(ids).map(([key, id]) => [
      key,
      `${marker.toLowerCase()}-${key}-${id}@example.test`,
    ])
  ) as Record<keyof typeof ids, string>;
  for (const [key, userId] of Object.entries(ids)) {
    await prisma.user.upsert({
      where: { userId },
      update: {},
      create: { userId, email: emails[key as keyof typeof ids], name: `Team fixture ${key}` },
    });
  }
  const teams = { atlas: randomUUID(), orbit: randomUUID(), unrelated: randomUUID() };
  const member = (key: keyof typeof ids, owner = false) => ({
    userId: ids[key],
    email: emails[key],
    role: owner ? 'OWNER' : 'MEMBER',
    status: 'ACCEPTED',
    acceptedAt: new Date(),
  });
  await prisma.team.create({
    data: {
      id: teams.atlas,
      name: `${marker} Atlas`,
      ownerUserId: ids.reader,
      members: {
        create: [
          member('reader', true),
          member('teammate'),
          { ...member('pending'), status: 'INVITED', acceptedAt: null },
        ],
      },
    },
  });
  await prisma.team.create({
    data: {
      id: teams.orbit,
      name: `${marker} Orbit`,
      ownerUserId: ids.orbit,
      members: { create: [member('orbit', true), member('reader'), member('teammate')] },
    },
  });
  await prisma.team.create({
    data: {
      id: teams.unrelated,
      name: `${marker} Unrelated`,
      ownerUserId: ids.outsider,
      members: { create: [member('outsider', true), member('teammate')] },
    },
  });
  const integrations: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  const people: Record<string, string> = {};
  const messageIds: string[] = [];
  const addMessages = async (
    key: keyof typeof ids,
    account: string | null,
    count: number,
    tag = 'SENT investor',
    channel: 'EMAIL' | 'IMESSAGE' = 'EMAIL'
  ) => {
    for (let n = 0; n < count; n++) {
      const row = await prisma.messageRecord.create({
        data: {
          userId: ids[key],
          personId: people[key],
          channel,
          from: tag.startsWith('RECEIVED') ? 'investor@example.test' : (account ?? '+15550000000'),
          to: tag.startsWith('RECEIVED') ? (account ?? '+15550000000') : 'investor@example.test',
          googleAccountEmail: channel === 'EMAIL' ? account : null,
          message: `${marker} ${tag} ${key} ${n}`,
          timestamp: new Date(Date.UTC(2026, 10, 10, 10, 0, messageIds.length)),
          externalId: randomUUID(),
        },
      });
      messageIds.push(row.id);
    }
  };
  for (const key of Object.keys(ids) as Array<keyof typeof ids>) {
    people[key] = (
      await prisma.person.create({
        data: {
          userId: ids[key],
          firstName: 'Investor',
          lastName: key,
          email: `contact-${ids[key]}@example.test`,
        },
      })
    ).id;
    integrations[key] = (
      await prisma.integration.create({
        data: {
          userId: ids[key],
          name: 'gmail',
          accountId: `${marker}:${ids[key]}`,
          type: 'DATA_SOURCE',
          status: 'CONNECTED',
          isActive: true,
        },
      })
    ).id;
    credentials[key] = (
      await prisma.emailIntegrationCredential.create({
        data: {
          userId: ids[key],
          integrationId: integrations[key],
          provider: 'GMAIL',
          email: emails[key],
          state: 'connected',
        },
      })
    ).id;
  }
  const share = (key: keyof typeof ids, teamId: string, account = emails[key]) =>
    prisma.teamIntegrationShare.create({
      data: {
        teamId,
        integrationId: integrations[key],
        ownerUserId: ids[key],
        provider: 'gmail',
        accountId: account,
        accountEmail: account,
      },
    });
  await share('reader', teams.atlas);
  await share('teammate', teams.atlas);
  await share('teammate', teams.orbit); // overlap must not duplicate messages
  await share('orbit', teams.orbit);
  await share('outsider', teams.unrelated); // transitive membership is not authority
  await share('pending', teams.atlas); // an invitation is not a membership
  await addMessages('reader', emails.reader, 2);
  await addMessages('noTeam', emails.noTeam, 2);
  await addMessages('teammate', emails.teammate, 3);
  await addMessages('orbit', emails.orbit, 1);
  await addMessages('outsider', emails.outsider, 7, 'PRIVATE SENT investor');
  await addMessages('pending', emails.pending, 5, 'PRIVATE SENT investor');
  const privateEmail = `private-${ids.teammate}@example.test`;
  await prisma.emailIntegrationCredential.create({
    data: {
      userId: ids.teammate,
      integrationId: integrations.teammate,
      provider: 'GMAIL',
      email: privateEmail,
      state: 'connected',
    },
  });
  await addMessages('teammate', privateEmail, 8, 'PRIVATE SENT investor');
  const revokedEmail = `revoked-${ids.teammate}@example.test`;
  await prisma.emailIntegrationCredential.create({
    data: {
      userId: ids.teammate,
      integrationId: integrations.teammate,
      provider: 'GMAIL',
      email: revokedEmail,
      state: 'needs_reconnect',
    },
  });
  await share('teammate', teams.atlas, revokedEmail);
  await addMessages('teammate', revokedEmail, 4, 'PRIVATE REVOKED SENT investor');
  await addMessages('teammate', null, 2, 'PRIVATE UNATTRIBUTED SENT investor');
  await addMessages('teammate', emails.teammate, 1, 'RECEIVED investor reply');
  const imessage = await prisma.integration.create({
    data: {
      userId: ids.teammate,
      name: 'imessage',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  await prisma.teamIntegrationShare.create({
    data: {
      teamId: teams.atlas,
      integrationId: imessage.id,
      ownerUserId: ids.teammate,
      provider: 'imessage',
      accountId: '',
    },
  });
  await addMessages('teammate', null, 1, 'shared iMessage hello', 'IMESSAGE');
  const project = await prisma.project.create({
    data: {
      userId: ids.teammate,
      name: `${marker} Shared Research`,
      syncSalt: randomUUID(),
      startupScript: 'SECRET_STARTUP_DO_NOT_EXPOSE',
    },
  });
  const agent = await prisma.agent.create({
    data: {
      userId: ids.teammate,
      projectId: project.id,
      goal: 'SECRET_GOAL_DO_NOT_EXPOSE',
      title: `${marker} Shared investor research`,
      status: 'COMPLETED',
    },
  });
  await prisma.teamProjectShare.create({
    data: { teamId: teams.atlas, projectId: project.id, ownerUserId: ids.teammate },
  });
  return {
    ids,
    emails,
    teams,
    integrations,
    credentials,
    people,
    privateEmail,
    revokedEmail,
    marker,
    imessageId: imessage.id,
    projectId: project.id,
    agentId: agent.id,
    messageIds,
    createdReader,
  };
}

export async function cleanupTeamDataFixture(
  fixture: Awaited<ReturnType<typeof seedTeamDataFixture>>
) {
  await prisma.team.deleteMany({ where: { id: { in: Object.values(fixture.teams) } } });
  await prisma.agent.deleteMany({ where: { projectId: fixture.projectId } });
  await prisma.project.deleteMany({ where: { id: fixture.projectId } });
  await prisma.person.deleteMany({ where: { id: { in: Object.values(fixture.people) } } });
  await prisma.integration.deleteMany({
    where: { id: { in: [...Object.values(fixture.integrations), fixture.imessageId] } },
  });
  await prisma.user.deleteMany({
    where: {
      userId: {
        in: Object.values(fixture.ids).filter(
          (id) => id !== fixture.ids.reader || fixture.createdReader
        ),
      },
    },
  });
}
