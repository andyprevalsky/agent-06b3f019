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
    assert.equal(
      (await search({ owner_user_id: f.ids.reader, team_id: f.teams.atlas })).total_matches,
      2,
      'own account shared into atlas'
    );
    assert.equal(
      (await search({ owner_user_id: f.ids.reader, team_id: f.teams.orbit })).total_matches,
      0
    );
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
    assert.equal((await search({ team_id: f.teams.atlas }, f.ids.noTeam)).total_matches, 0);
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
        (
          await search({
            source,
            team_id: f.teams.atlas,
            pattern: 'SECRET|Investor',
            agent_id: f.agentId,
          })
        ).total_matches,
        0,
        source
      );
    }
    const context = await fetch(`${BASE_URL}/api/data/team-context`, {
      headers: apiHeaders(f.ids.reader),
    });
    assert.equal(context.status, 200);
    const map = await context.json();
    assert.deepEqual(map.you, { userId: f.ids.reader }, 'caller id lets explore narrow to own');
    assert.ok(JSON.stringify(map).includes(f.projectId), 'explicit shared project is discoverable');
    assert.ok(!('projectAgents' in map), 'list_agents, not the context map, lists project agents');
    assert.ok(!JSON.stringify(map).includes('SECRET'), 'discovery is metadata only');
    assert.ok(
      !JSON.stringify(map).includes(f.privateEmail),
      'private account absent from shared map'
    );
    // list_agents across own + explicitly shared projects (GET /api/data/project-agents).
    type ListedAgents = {
      total: number;
      next_offset: number | null;
      agents: Array<Record<string, unknown>>;
    };
    const listAgents = async (params: Record<string, string>, userId = f.ids.reader) => {
      const response = await fetch(
        `${BASE_URL}/api/data/project-agents?${new URLSearchParams(params).toString()}`,
        { headers: apiHeaders(userId) }
      );
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as ListedAgents;
    };
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
    const listed = await listAgents({ project_id: f.projectId });
    assert.equal(listed.total, 27);
    assert.equal(listed.agents.length, 20);
    assert.equal(listed.next_offset, 20);
    assert.deepEqual(Object.keys(listed.agents[0]).sort(), [
      'id',
      'own',
      'owner_name',
      'owner_user_id',
      'project_id',
      'project_name',
      'status',
      'team_ids',
      'title',
      'updated_at',
    ]);
    assert.equal(listed.agents[0].owner_user_id, f.ids.teammate);
    assert.equal(listed.agents[0].owner_name, 'Team fixture teammate');
    assert.equal(listed.agents[0].project_name, `${f.marker} Shared Research`);
    assert.deepEqual(listed.agents[0].team_ids, [f.teams.atlas]);
    assert.ok(!JSON.stringify(listed).includes('SECRET'), 'no goals, env or startup script');
    const tail = await listAgents({ project_id: f.projectId, offset: '20' });
    assert.equal(tail.agents.length, 7);
    assert.equal(tail.next_offset, null);
    assert.ok(JSON.stringify(tail).includes(olderId), 'older shared agent retrievable by paging');
    assert.equal(
      (await listAgents({ q: 'older needle', team_id: f.teams.atlas })).total,
      1,
      'words in any order match the title'
    );
    assert.equal((await listAgents({ owner_user_id: f.ids.teammate })).total, 27);
    assert.equal((await listAgents({ q: 'SECRET' })).total, 0, 'goals never searched');
    assert.equal(
      (await listAgents({ team_id: f.teams.orbit })).total,
      0,
      'project not shared into other team'
    );
    assert.equal(
      (await listAgents({ owner_user_id: f.ids.teammate }, f.ids.noTeam)).total,
      0,
      'no team, no shared projects'
    );
    assert.equal(
      (await listAgents({ owner_user_id: f.ids.teammate }, f.ids.outsider)).total,
      0,
      'no transitive sharing'
    );
    const badParams: Array<Record<string, string>> = [
      { project_id: ' ' },
      { offset: '-1' },
      { limit: '500' },
    ];
    for (const params of badParams) {
      const bad = await fetch(
        `${BASE_URL}/api/data/project-agents?${new URLSearchParams(params).toString()}`,
        { headers: apiHeaders(f.ids.reader) }
      );
      assert.equal(bad.status, 400, JSON.stringify(params));
    }
    // Own projects join only when a filter asks; a bare query lists teammates' shares.
    const ownProject = await prisma.project.create({
      data: { userId: f.ids.reader, name: 'Own private project', syncSalt: randomUUID() },
    });
    const secondProject = await prisma.project.create({
      data: { userId: f.ids.teammate, name: 'Multi team project', syncSalt: randomUUID() },
    });
    try {
      const ownAgent = await prisma.agent.create({
        data: {
          userId: f.ids.reader,
          projectId: ownProject.id,
          title: 'Own needle agent',
          goal: 'SECRET_OWN_GOAL',
          status: 'ACTIVE',
        },
      });
      const own = await listAgents({ owner_user_id: f.ids.reader });
      assert.equal(own.total, 1);
      assert.equal(own.agents[0].id, ownAgent.id);
      assert.equal(own.agents[0].own, true);
      assert.equal((await listAgents({ q: 'Own needle' })).total, 0, 'own tree covers own agents');
      await prisma.teamProjectShare.createMany({
        data: [f.teams.atlas, f.teams.orbit].map((teamId) => ({
          teamId,
          projectId: secondProject.id,
          ownerUserId: f.ids.teammate,
        })),
      });
      const multi = await prisma.agent.create({
        data: {
          userId: f.ids.teammate,
          projectId: secondProject.id,
          title: 'Multi team agent',
          goal: 'SECRET_MULTI_GOAL',
          status: 'COMPLETED',
        },
      });
      const both = await listAgents({ project_id: secondProject.id });
      assert.equal(both.total, 1, 'two team shares do not duplicate an agent');
      assert.deepEqual(
        [...(both.agents[0].team_ids as string[])].sort(),
        [f.teams.atlas, f.teams.orbit].sort()
      );
      assert.equal((await listAgents({ team_id: f.teams.orbit })).agents[0].id, multi.id);
    } finally {
      await prisma.agent.deleteMany({
        where: { projectId: { in: [ownProject.id, secondProject.id] } },
      });
      await prisma.project.deleteMany({ where: { id: { in: [ownProject.id, secondProject.id] } } });
    }
    const summary = await search({ source: 'summary', team_id: f.teams.atlas });
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
      search: { teamId: f.teams.orbit },
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
          label: f.emails.teammate,
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
      !JSON.stringify(await removed.json()).includes(f.projectId),
      'project membership revocation live'
    );
    assert.equal(
      (await listAgents({ project_id: f.projectId })).total,
      0,
      'list_agents revalidates membership'
    );
    for (const params of [
      { scope: 'own' },
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
