/** HTTP regressions for the live, per-account team data boundary. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { countMessageGrepRows } from '../../domains/data/grepRepo';
import {
  searchConversationMatchRows,
  findMessageContextRows,
} from '../../domains/data/messageContextRepo';
import type { MessageAccess } from '../../domains/data/teamAccessRepo';
import { apiHeaders, BASE_URL, requestGrep } from './data-grep.helpers';
import {
  seedTeamDataFixture,
  cleanupTeamDataFixture,
  TEAM_BENCH_MARKER,
} from './data-teams.fixture';

async function run() {
  const readerId = randomUUID();
  await prisma.user.create({ data: { userId: readerId, name: 'Existing reader' } });
  const existing = await prisma.integration.create({
    data: {
      userId: readerId,
      name: 'gmail',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const f = await seedTeamDataFixture(readerId);
  const search = async (params: Record<string, unknown> = {}, userId = f.ids.reader) => {
    const response = await requestGrep(userId, {
      pattern: `${TEAM_BENCH_MARKER}.*SENT investor`,
      source: 'email',
      ...params,
    });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    return response.data as {
      total_matches: number;
      matches: Array<{
        content: string;
        ownership: { owner_user_id: string; account_id: string; team_ids: string[] };
        records: Array<{ message: string }>;
      }>;
      [key: string]: unknown;
    };
  };
  try {
    assert.equal(
      (await search()).total_matches,
      6,
      'default own + direct shared accounts; duplicates do not multiply rows'
    );
    assert.equal((await search({ scope: 'own' })).total_matches, 2);
    assert.equal(
      (await search({ person: 'Investor' })).total_matches,
      6,
      'same named contact across owners'
    );
    assert.equal(
      (await search({ owner_user_id: f.ids.reader })).total_matches,
      2,
      'owner=self includes private own data'
    );
    assert.equal(
      (await search({ scope: 'shared' })).total_matches,
      6,
      'self shared account is explicit'
    );
    assert.equal((await search({ team_id: f.teams.atlas })).total_matches, 5);
    assert.equal(
      (await search({ source: 'gmail', pattern: TEAM_BENCH_MARKER })).total_matches,
      7,
      'gmail is exactly the email channel'
    );
    assert.equal((await search({ source: 'email', pattern: TEAM_BENCH_MARKER })).total_matches, 7);
    assert.equal(
      (await search({ source: 'messages', pattern: TEAM_BENCH_MARKER })).total_matches,
      8,
      'messages still includes shared iMessage'
    );

    assert.equal((await search({ team_id: f.teams.orbit })).total_matches, 4);
    assert.equal((await search({ scope: 'own', team_id: f.teams.atlas })).total_matches, 2);
    assert.equal((await search({ scope: 'own', team_id: f.teams.orbit })).total_matches, 0);
    assert.equal((await search({ owner_user_id: f.ids.teammate })).total_matches, 3);
    assert.equal((await search({ account_id: f.emails.teammate })).total_matches, 3);
    assert.equal((await search({ account_id: f.privateEmail })).total_matches, 0);
    assert.equal(
      (await search({ owner_user_id: f.ids.outsider })).total_matches,
      0,
      'no transitive sharing'
    );
    assert.equal((await search({ team_id: f.teams.unrelated })).total_matches, 0);
    assert.equal(
      (await search({ owner_user_id: f.ids.pending })).total_matches,
      0,
      'pending owner cannot share'
    );
    assert.equal(
      (await search({ team_id: f.teams.atlas }, f.ids.pending)).total_matches,
      0,
      'pending reader cannot read'
    );
    assert.equal((await search({}, f.ids.noTeam)).total_matches, 2, 'no-team default is own-only');
    assert.equal((await search({ scope: 'shared' }, f.ids.noTeam)).total_matches, 0);
    const page = await search({ team_id: f.teams.atlas, head_limit: 1, offset: 4, '-C': 25 });
    assert.equal(page.matches.length, 1, 'pagination after authorization');
    assert.equal(page.total_matches, 5);
    assert.equal(page.matches[0].ownership.owner_user_id, f.ids.teammate);
    assert.equal(page.matches[0].ownership.account_id, f.emails.teammate);
    assert.ok(
      !JSON.stringify(page).includes('PRIVATE'),
      'private records must not enter neighbor context'
    );
    assert.equal(
      (await search({ source: 'imessage', pattern: 'shared iMessage' })).total_matches,
      1
    );
    for (const source of [
      'network',
      'documents',
      'transactions',
      'agent_network',
      'agent_trajectories',
    ]) {
      assert.equal(
        (await search({ source, scope: 'shared', pattern: 'SECRET|Investor', agent_id: f.agentId }))
          .total_matches,
        0,
        source
      );
    }
    const context = await fetch(`${BASE_URL}/api/data/team-context`, {
      headers: apiHeaders(f.ids.reader),
    });
    assert.equal(context.status, 200);
    const map = await context.json();
    assert.ok(
      JSON.stringify(map).includes(f.agentId),
      'explicit shared project agent is discoverable'
    );
    assert.ok(!JSON.stringify(map).includes('SECRET'), 'discovery is metadata only');
    assert.ok(
      !JSON.stringify(map).includes(f.privateEmail),
      'private account absent from shared map'
    );
    const olderId = randomUUID();
    await prisma.agent.createMany({
      data: [
        {
          id: olderId,
          userId: f.ids.teammate,
          projectId: f.projectId,
          title: 'Older findable needle',
          goal: 'SECRET_OLDER_GOAL',
          status: 'COMPLETED',
          updatedAt: new Date('2020-01-01'),
        },
        ...Array.from({ length: 25 }, (_, n) => ({
          userId: f.ids.teammate,
          projectId: f.projectId,
          title: `Newer shared agent ${n}`,
          goal: 'SECRET_NEVER_SEARCH_GOAL',
          status: 'COMPLETED' as const,
        })),
      ],
    });
    const listed = await search({
      source: 'shared_project_agents',
      pattern: '',
      filters: { project_id: f.projectId },
      head_limit: 20,
    });
    assert.equal(listed.total_matches, 27);
    assert.equal(listed.matches.length, 20);
    const tail = await search({
      source: 'shared_project_agents',
      pattern: '',
      filters: { project_id: f.projectId },
      head_limit: 20,
      offset: 20,
    });
    assert.equal(tail.matches.length, 7);
    assert.ok(
      JSON.stringify(tail).includes(olderId),
      'older shared agent retrievable beyond context preview'
    );
    const found = await search({
      source: 'shared_project_agents',
      pattern: 'Older findable needle',
      team_id: f.teams.atlas,
    });
    assert.equal(found.total_matches, 1);
    const address = `shared_project_agents/${f.projectId}/${olderId}`;
    assert.equal(
      (await search({ source: 'shared_project_agents', pattern: '', filters: { path: address } }))
        .total_matches,
      1
    );
    assert.equal(
      (await search({ source: 'shared_project_agents', pattern: 'SECRET' })).total_matches,
      0,
      'goals never indexed or returned'
    );
    assert.equal(
      (await search({ source: 'shared_project_agents', pattern: '', team_id: f.teams.orbit }))
        .total_matches,
      0,
      'project not shared into other team'
    );
    const secondProject = await prisma.project.create({
      data: { userId: f.ids.teammate, name: 'Tie paging project', syncSalt: randomUUID() },
    });
    try {
      await prisma.teamProjectShare.create({
        data: { teamId: f.teams.atlas, projectId: secondProject.id, ownerUserId: f.ids.teammate },
      });
      const orderedProjects = [f.projectId, secondProject.id].sort();
      const reverseIds = [randomUUID(), randomUUID()].sort().reverse();
      const tie = `tie-${randomUUID()}`;
      await prisma.agent.createMany({
        data: orderedProjects.map((projectId, n) => ({
          id: reverseIds[n],
          projectId,
          userId: f.ids.teammate,
          title: tie,
          goal: 'SECRET_TIE_GOAL',
          status: 'COMPLETED' as const,
          updatedAt: new Date('2001-01-01'),
        })),
      });
      const firstPage = await search({
        source: 'shared_project_agents',
        pattern: tie,
        head_limit: 1,
      });
      const nextPage = await search({
        source: 'shared_project_agents',
        pattern: tie,
        head_limit: 1,
        offset: 1,
      });
      assert.ok(
        JSON.stringify(firstPage.matches).includes(reverseIds[0]),
        'equal-time order follows emitted project/agent path'
      );
      assert.ok(
        JSON.stringify(nextPage.matches).includes(reverseIds[1]),
        'second page does not repeat first agent'
      );
    } finally {
      await prisma.agent.deleteMany({ where: { projectId: secondProject.id } });
      await prisma.project.delete({ where: { id: secondProject.id } });
    }
    const summary = await search({ source: 'summary', scope: 'shared' });
    assert.ok(
      !JSON.stringify(summary).includes('PRIVATE'),
      'shared summary has no private message text'
    );
    // Separate daily tasks share a local stack/user: neither fixture may reuse the other's credential key.
    const nextFixture = await seedTeamDataFixture(readerId, 'ROSE-TEAM-SECOND');
    try {
      assert.equal((await search({ pattern: 'ROSE-TEAM-SECOND.*SENT investor' })).total_matches, 6);
      assert.equal(
        (await search()).total_matches,
        6,
        'second fixture does not contaminate first task counts'
      );
    } finally {
      await cleanupTeamDataFixture(nextFixture);
    }
    // Revoke one overlapping grant; the other team still authorizes it.
    await prisma.teamIntegrationShare.deleteMany({
      where: { teamId: f.teams.atlas, ownerUserId: f.ids.teammate, provider: 'gmail' },
    });
    assert.equal((await search({ team_id: f.teams.atlas })).total_matches, 2);
    assert.equal((await search()).total_matches, 6);
    // Disconnect the exact credential while its parent remains connected.
    await prisma.emailIntegrationCredential.update({
      where: { id: f.credentials.teammate },
      data: { state: 'needs_reconnect' },
    });
    assert.equal((await search()).total_matches, 3);
    await prisma.emailIntegrationCredential.update({
      where: { id: f.credentials.teammate },
      data: { state: 'connected' },
    });
    const staleAccess: MessageAccess = {
      userId: f.ids.reader,
      search: { scope: 'shared', teamId: f.teams.orbit },
      grants: [
        {
          teamId: f.teams.orbit,
          teamName: 'Orbit',
          ownerUserId: f.ids.teammate,
          ownerName: 'Teammate',
          integrationId: f.integrations.teammate,
          provider: 'gmail',
          accountId: f.emails.teammate,
          accountEmail: f.emails.teammate,
        },
      ],
    };
    await prisma.teamMember.updateMany({
      where: { teamId: f.teams.orbit, userId: f.ids.reader },
      data: { status: 'INVITED' },
    });
    assert.equal((await search()).total_matches, 2, 'reader revocation live');
    const staleQuery = {
      userId: f.ids.reader,
      access: staleAccess,
      pattern: TEAM_BENCH_MARKER,
      caseInsensitive: false,
    };
    assert.equal(await countMessageGrepRows(staleQuery), 0, 'SQL count revalidates stale grant');
    assert.equal(
      (await searchConversationMatchRows({ ...staleQuery, limit: 20, offset: 0 })).length,
      0,
      'SQL row query revalidates stale grant'
    );
    assert.equal(
      (
        await findMessageContextRows({
          userId: f.ids.reader,
          access: staleAccess,
          anchorIds: f.messageIds,
          before: 25,
          after: 25,
        })
      ).length,
      0,
      'SQL neighbors revalidate stale grant'
    );

    await prisma.teamMember.updateMany({
      where: { teamId: f.teams.atlas, userId: f.ids.teammate },
      data: { status: 'INVITED' },
    });
    const removed = await fetch(`${BASE_URL}/api/data/team-context`, {
      headers: apiHeaders(f.ids.reader),
    });
    assert.ok(
      !JSON.stringify(await removed.json()).includes(f.agentId),
      'project membership revocation live'
    );
    for (const params of [
      { scope: 'bogus' },
      { team_id: [] },
      { owner_user_id: '' },
      { account_id: 5 },
    ]) {
      assert.equal((await requestGrep(f.ids.reader, { pattern: 'x', ...params })).status, 400);
    }
    console.log(
      'PASS data-teams: account authorization, counts, pages, context, metadata, revocation'
    );
  } finally {
    await cleanupTeamDataFixture(f);
    await prisma.integration.delete({ where: { id: existing.id } });
    await prisma.user.delete({ where: { userId: readerId } });
    await prisma.$disconnect();
  }
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
