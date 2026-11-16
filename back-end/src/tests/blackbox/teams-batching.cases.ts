/** Multi-team/account query batching uses real Prisma operations and HTTP results. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { prisma } from '../../providers/database';
import { currentTraceContext, withSpan } from '../../providers/tracing';
import * as service from '../../domains/teams/service';
import { user, request, team, join, gmail } from './teams-harness';

/** Count real Prisma operations for one trace; no repository/DB response is mocked. */
async function captureReads<T>(t: TestContext, run: () => Promise<T>) {
  const written = t.mock.method(process.stdout, 'write');
  let spanId = '';
  try {
    const value = await withSpan('teams.query-batching-test', {}, async () => {
      spanId = currentTraceContext()!.span_id;
      return run();
    });
    const counts: Record<string, number> = {};
    for (const call of written.mock.calls) {
      const line = String(call.arguments[0]);
      if (!line.includes('db.query')) continue;
      let model: string | undefined;
      let operation: string | undefined;
      if (line.startsWith('{')) {
        const entry = JSON.parse(line) as {
          parent_span_id?: string;
          model?: string;
          operation?: string;
        };
        if (entry.parent_span_id !== spanId) continue;
        ({ model, operation } = entry);
      } else {
        if (!line.includes(`parent_span_id=${spanId} `)) continue;
        [, model, operation] = /\bmodel=(\w+) operation=(\w+)/.exec(line) ?? [];
      }
      if (model !== undefined && operation !== undefined) {
        const key = `${model}.${operation}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return { value, counts };
  } finally {
    written.mock.restore();
  }
}
test('multi-team listing batches reads and preserves rosters, grants, and pending visibility', async (t) => {
  const reader = await user('Reader');
  const peer = await user('Peer');
  const invited = await user('Invited');
  const alpha = String((await team(reader, 'Alpha')).id);
  const beta = String((await team(peer, 'Beta')).id);
  const hidden = String((await team(peer, 'Pending only')).id);
  await join(reader, peer, alpha);
  await join(peer, reader, beta);
  await request(peer, `/${hidden}/invites`, 'POST', { email: reader.email }, 201);
  await request(peer, `/${beta}/invites`, 'POST', { email: invited.email }, 201);
  const futureEmail = `future-${randomUUID()}@example.test`;
  await request(reader, `/${alpha}/invites`, 'POST', { email: futureEmail }, 201);
  const future = await user('Newly registered');
  await prisma.user.update({ where: { userId: future.userId }, data: { email: futureEmail } });
  const { credentials } = await gmail(peer);
  await request(peer, `/${beta}/integrations/${credentials[0].id}`, 'PUT', {});
  await request(peer, `/${hidden}/integrations/${credentials[1].id}`, 'PUT', {});
  const project = await prisma.project.create({
    data: { userId: peer.userId, name: 'Beta project', syncSalt: randomUUID() },
  });
  await request(peer, `/${beta}/projects/${project.id}`, 'PUT', {});
  await request(peer, `/${hidden}/projects/${project.id}`, 'PUT', {});

  const { value: listed, counts } = await captureReads(t, () => service.listTeams(reader.userId));
  assert.deepEqual(
    listed.teams.map((row) => row.id),
    [alpha, beta]
  );
  assert.equal(listed.teams[0].role, 'OWNER');
  assert.equal(listed.teams[1].role, 'MEMBER');
  assert.equal(
    listed.teams[0].members.find((row) => row.email === futureEmail)?.name,
    'Newly registered'
  );
  assert.equal(listed.teams[0].members.find((row) => row.email === futureEmail)?.onRose, true);
  assert.equal(
    listed.teams[1].members.find((row) => row.userId === invited.userId)?.status,
    'INVITED'
  );
  assert.equal(listed.teams[0].integrationShares.length, 0);
  assert.equal(listed.teams[1].integrationShares[0].accountEmail, credentials[0].email);
  assert.deepEqual(listed.teams[0].projectShares, []);
  assert.equal(listed.teams[1].projectShares[0].projectId, project.id);
  assert.deepEqual(
    listed.invitations.map((row) => row.id),
    [hidden]
  );
  assert.deepEqual(listed.invitations[0].members, []);
  assert.deepEqual(listed.invitations[0].integrationShares, []);
  assert.deepEqual(listed.invitations[0].projectShares, []);
  assert.equal(counts['Team.findUnique'] ?? 0, 0, 'list must not reload teams individually');
  assert.equal(counts['TeamMember.findMany'], 2, 'one team batch + invitation batch');
  assert.equal(counts['TeamIntegrationShare.findMany'], 1, 'one grant batch');
  assert.equal(counts['TeamProjectShare.findMany'], 1, 'one shared project batch');
  assert.equal(counts['User.findMany'], 1, 'one email-status batch');
  for (let i = 0; i < 6; i++) await team(reader, `Extra ${i}`);
  const larger = await captureReads(t, () => service.listTeams(reader.userId));
  assert.equal(larger.value.teams.length, 8);
  assert.deepEqual(larger.counts, counts, 'eight teams use the same read batches as two');
  assert.deepEqual(
    larger.value.teams.slice(0, 2),
    listed.teams,
    'extra teams do not change existing visibility'
  );
  assert.deepEqual(await request(reader, ''), larger.value, 'HTTP list uses the same full DTOs');
  assert.deepEqual(await service.getTeam(reader.userId, beta), listed.teams[1]);
  await assert.rejects(service.getTeam(reader.userId, hidden), { status: 404 });
});

test('shareable account listing batches provider and grant reads independent of inbox count', async (t) => {
  const owner = await user();
  const outsider = await user();
  const { integration, credentials } = await gmail(owner);
  await gmail(outsider);
  const imessage = await prisma.integration.create({
    data: {
      userId: owner.userId,
      name: 'imessage',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  const id = String((await team(owner)).id);
  await request(owner, `/${id}/integrations/${credentials[0].id}`, 'PUT', {});
  await request(owner, `/${id}/integrations/${imessage.id}`, 'PUT', {});
  const before = await captureReads(t, () => service.listShareableIntegrations(owner.userId));
  assert.equal(before.value.integrations.length, 3);
  assert.equal(before.counts['Integration.findMany'], 1);
  assert.equal(before.counts['Integration.count'] ?? 0, 0, 'no per-provider ambiguity counts');
  assert.equal(
    before.counts['Integration.groupBy'],
    2,
    'single-account ambiguity checked in one batch for the lister and one for grant owners'
  );
  assert.equal(before.counts['PlaidItem.findMany'] ?? 0, 0, 'no bank reads without a bank');
  assert.equal(before.counts['TeamIntegrationShare.findMany'], 1);
  assert.equal(
    before.counts['EmailIntegrationCredential.findMany'] ?? 0,
    0,
    'credentials loaded through the provider batch'
  );
  await prisma.emailIntegrationCredential.createMany({
    data: Array.from({ length: 25 }, (_, index) => ({
      userId: owner.userId,
      integrationId: integration.id,
      provider: 'GMAIL' as const,
      email: `inbox-${index}-${owner.email}`,
      state: 'connected',
    })),
  });
  const after = await captureReads(t, () => service.listShareableIntegrations(owner.userId));
  assert.equal(after.value.integrations.length, 28);
  assert.deepEqual(after.counts, before.counts, 'additional inboxes add no per-account reads');
  assert.deepEqual(
    after.value.integrations.find((account) => account.id === credentials[0].id)?.teamIds,
    [id]
  );
  assert(after.value.integrations.every((account) => account.ownerUserId === owner.userId));
});
