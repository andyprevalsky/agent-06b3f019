#!/usr/bin/env tsx
/** Teams HTTP lifecycle and live access regression suite. Discovered by run.ts. */
import { apiKeyHeaders, call, expectStatus } from './projects-harness';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import * as service from '../../domains/teams/service';
import { TransactionalEmailDefinitiveError } from '../../providers/transactionalEmail';
import { INVITE_SENDING_LEASE_MS } from '../../domains/teams/config';
import { user, request, team, join, gmail } from './teams-harness';
import './teams-batching.cases';

test('teams authenticate, validate, require existing account and keep members opt-in', async () => {
  expectStatus(await call('/api/teams'), 401, 'auth boundary');
  const owner = await user('Owner');
  const member = await user('Member');
  const outsider = await user();
  await request({ ...outsider, userId: randomUUID() }, '', 'GET', undefined, 404);
  await request(owner, '', 'POST', { name: '' }, 400);
  await request(owner, '', 'POST', { name: 'x', unexpected: true }, 400);
  const created = await team(owner, 'First Team');
  const id = String(created.id);
  assert.equal(created.role, 'OWNER');
  assert.deepEqual(created.integrationShares, []);
  await request(outsider, `/${id}`, 'GET', undefined, 404);
  const invitation = await request(
    owner,
    `/${id}/invites`,
    'POST',
    { email: member.email.toUpperCase() },
    201
  );
  assert.equal((invitation.member as { status: string }).status, 'INVITED');
  const pending = await request(member, '');
  assert.equal((pending.teams as unknown[]).length, 0);
  assert.equal((pending.invitations as unknown[]).length, 1);
  await request(member, `/${id}`, 'GET', undefined, 404);
  await request(outsider, `/${id}/accept`, 'POST', {}, 404);
  await request(member, `/${id}/accept`, 'POST', { userId: owner.userId }, 400);
  await request(member, `/${id}/accept`, 'POST', {});
  await request(member, `/${id}/accept`, 'POST', {});
  await request(member, `/${id}`, 'PATCH', { name: 'Forbidden' }, 403);
  assert.equal((await request(owner, `/${id}`, 'PATCH', { name: 'Renamed' })).name, 'Renamed');
  await request(member, `/${id}/invites`, 'POST', { email: outsider.email }, 403);
  await request(
    owner,
    `/${id}/members/${(created.members as Array<{ id: string }>)[0].id}`,
    'DELETE',
    undefined,
    403
  );
});

test('email accounts are individually opted in, private integrations denied, revocation is live', async () => {
  const owner = await user();
  const member = await user();
  const outsider = await user();
  const id = String((await team(owner)).id);
  await join(owner, member, id);
  const { integration, credentials } = await gmail(owner);
  const privateIntegration = await prisma.integration.create({
    data: {
      userId: owner.userId,
      name: 'iphone',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      config: { secret: 'NEVER-EXPOSE' },
    },
  });
  const options = await request(owner, '/shareable-integrations');
  assert.equal((options.integrations as unknown[]).length, 2);
  assert(!JSON.stringify(options).includes('NEVER-EXPOSE'));
  assert.deepEqual(await service.resolveTeamDataAccess(member.userId), []);
  await request(owner, `/${id}/integrations/${integration.id}`, 'PUT', {}, 400);
  await request(owner, `/${id}/integrations/${privateIntegration.id}`, 'PUT', {}, 400);
  await request(member, `/${id}/integrations/${credentials[0].id}`, 'PUT', {}, 400);
  await request(owner, `/${id}/integrations/${credentials[0].id}`, 'PUT', {});
  await request(owner, `/${id}/integrations/${credentials[0].id}`, 'PUT', {});
  let grants = await service.resolveTeamDataAccess(member.userId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].accountEmail, credentials[0].email);
  assert.equal((await service.resolveTeamDataAccess(outsider.userId)).length, 0);
  assert.equal(
    (await service.resolveTeamDataAccess(member.userId, { teamId: randomUUID() })).length,
    0
  );
  assert.equal(
    (await service.resolveTeamDataAccess(member.userId, { ownerUserId: outsider.userId })).length,
    0
  );
  await prisma.emailIntegrationCredential.update({
    where: { id: credentials[0].id },
    data: { state: 'needs_reconnect' },
  });
  assert.deepEqual(await service.resolveTeamDataAccess(member.userId), []);
  await prisma.emailIntegrationCredential.update({
    where: { id: credentials[0].id },
    data: { state: 'connected' },
  });
  await prisma.integration.update({ where: { id: integration.id }, data: { isActive: false } });
  assert.deepEqual(await service.resolveTeamDataAccess(member.userId), []);
  await prisma.integration.update({ where: { id: integration.id }, data: { isActive: true } });
  await request(owner, `/${id}/integrations/${credentials[0].id}`, 'DELETE', undefined, 204);
  assert.deepEqual(await service.resolveTeamDataAccess(member.userId), []);
  grants = await service.resolveTeamDataAccess(owner.userId);
  assert.equal(grants.length, 0);
});

test('removal revokes member-owned shares and re-inviting never restores consent; teams are non-transitive', async () => {
  const a = await user();
  const b = await user();
  const c = await user();
  const ab = String((await team(a, 'AB')).id);
  const bc = String((await team(b, 'BC')).id);
  await join(a, b, ab);
  await join(b, c, bc);
  const { credentials } = await gmail(b);
  await request(b, `/${ab}/integrations/${credentials[0].id}`, 'PUT', {});
  assert.equal((await service.resolveTeamDataAccess(a.userId)).length, 1);
  assert.equal((await service.resolveTeamDataAccess(c.userId)).length, 0);
  const members = (await request(a, `/${ab}`)).members as Array<{ id: string; userId: string }>;
  await request(
    a,
    `/${ab}/members/${members.find((m) => m.userId === b.userId)!.id}`,
    'DELETE',
    undefined,
    204
  );
  assert.equal((await service.resolveTeamDataAccess(a.userId)).length, 0);
  await join(a, b, ab);
  assert.equal((await service.resolveTeamDataAccess(a.userId)).length, 0);
  assert.equal(await prisma.teamIntegrationShare.count({ where: { teamId: ab } }), 0);
});

test('contacts use only caller records, match secondary email and refresh on-Rose status', async () => {
  const owner = await user();
  const outsider = await user();
  const email = `future-${randomUUID()}@example.test`;
  await prisma.person.create({
    data: {
      userId: owner.userId,
      firstName: 'Tamy',
      lastName: 'Test',
      emailAddresses: [{ email }],
    },
  });
  await prisma.person.create({
    data: {
      userId: outsider.userId,
      firstName: 'TamyPrivate',
      lastName: '',
      email: `secret-${email}`,
    },
  });
  let rows = (await request(owner, '/contacts?q=Tamy')).contacts as Array<{
    email: string;
    onRose: boolean;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, email);
  assert.equal(rows[0].onRose, false);
  const added = await user();
  await prisma.user.update({ where: { userId: added.userId }, data: { email } });
  rows = (await request(owner, `/contacts?q=${encodeURIComponent(email)}`)).contacts as typeof rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onRose, true);
  await prisma.user.update({
    where: { userId: added.userId },
    data: { email: `${randomUUID()}@example.test` },
  });
  assert.equal(
    ((await request(owner, '/contacts?q=Tamy')).contacts as typeof rows)[0].onRose,
    false
  );
});

test('contacts never reveal whether an arbitrary typed email has a Rose account', async () => {
  const owner = await user();
  const stranger = await user();
  const known = await user();
  await prisma.person.create({
    data: { userId: owner.userId, firstName: 'Known', lastName: 'Friend', email: known.email },
  });
  const typed = (await request(owner, `/contacts?q=${encodeURIComponent(stranger.email)}`))
    .contacts as Array<Record<string, unknown>>;
  assert.deepEqual(typed, [{ name: null, email: stranger.email }]);
  const own = (await request(owner, `/contacts?q=${encodeURIComponent(known.email)}`))
    .contacts as Array<Record<string, unknown>>;
  assert.deepEqual(own, [{ name: 'Known Friend', email: known.email, onRose: true }]);
  assert(own.every((row) => !('userId' in row)));
});

test('shared projects expose only bounded metadata; owner settings and secrets remain private', async () => {
  const owner = await user();
  const member = await user();
  const id = String((await team(owner)).id);
  await join(owner, member, id);
  const project = await prisma.project.create({
    data: {
      userId: owner.userId,
      name: 'Shared',
      syncSalt: 'PRIVATE-SALT',
      startupScript: 'PRIVATE-SCRIPT',
    },
  });
  await prisma.agent.create({
    data: {
      userId: owner.userId,
      projectId: project.id,
      goal: 'PRIVATE-GOAL',
      title: 'Agent title',
    },
  });
  await request(member, `/${id}/projects/${project.id}`, 'PUT', {}, 404);
  await request(owner, `/${id}/projects/${project.id}`, 'PUT', {});
  const discovery = await request(member, '/shared-projects');
  const rows = discovery.projects as Array<{ projectId: string; agents: Array<{ title: string }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].projectId, project.id);
  assert.equal(rows[0].agents[0].title, 'Agent title');
  assert(!JSON.stringify(discovery).includes('PRIVATE-'));
  expectStatus(
    await call(`/api/projects/${project.id}/env-files`, { headers: apiKeyHeaders(member.userId) }),
    404,
    'project credentials remain private'
  );
  await request(owner, `/${id}/projects/${project.id}`, 'DELETE', undefined, 204);
  assert.deepEqual((await request(member, '/shared-projects')).projects, []);
});

test('ambiguous email cannot bind or accept an invitation', async () => {
  const owner = await user();
  const member = await user();
  const duplicate = await user();
  await prisma.user.update({
    where: { userId: duplicate.userId },
    data: { email: member.email.toUpperCase() },
  });
  const id = String((await team(owner)).id);
  await request(owner, `/${id}/invites`, 'POST', { email: member.email }, 409);
  assert.equal(await prisma.teamMember.count({ where: { teamId: id } }), 1);
});

test('default iMessage can be shared but multiple device accounts fail closed', async () => {
  const owner = await user();
  const member = await user();
  const id = String((await team(owner)).id);
  await join(owner, member, id);
  const integration = await prisma.integration.create({
    data: {
      userId: owner.userId,
      name: 'imessage',
      type: 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
    },
  });
  await request(owner, `/${id}/integrations/${integration.id}`, 'PUT', {});
  assert.equal((await service.resolveTeamDataAccess(member.userId)).length, 1);
  await prisma.integration.create({
    data: {
      userId: owner.userId,
      name: 'imessage',
      accountId: 'second-device',
      type: 'DATA_SOURCE',
      status: 'NOT_CONNECTED',
      isActive: false,
    },
  });
  assert.equal((await service.resolveTeamDataAccess(member.userId)).length, 0);
  assert.deepEqual((await request(owner, '/shareable-integrations')).integrations, []);
});

test('invitation delivery records success and does not duplicate a sent or uncertain attempt', async () => {
  const owner = await user();
  const member = await user();
  const member2 = await user();
  const id = String((await team(owner)).id);
  let sends = 0;
  const sender = async (input: { to: string; body: string }) => {
    sends++;
    assert.equal(input.to, member.email);
    assert(input.body.includes(`team-invite=${id}`));
    return { id: 'mail-receipt' };
  };
  const sent = await service.inviteMember(owner.userId, id, member.email, sender);
  assert.equal(sent.delivery, 'sent');
  assert.equal(sent.member.status, 'INVITED');
  await service.inviteMember(owner.userId, id, member.email, sender);
  assert.equal(sends, 1);
  const unknown = await service.inviteMember(owner.userId, id, member2.email, async () => {
    sends++;
    throw new Error('Connection lost after submit');
  });
  assert.equal(unknown.delivery, 'unknown');
  await service.inviteMember(owner.userId, id, member2.email, async () => {
    sends++;
    return { id: 'bad-retry' };
  });
  assert.equal(sends, 2);
  const member3 = await user();
  const failed = await service.inviteMember(owner.userId, id, member3.email, async () => {
    throw new TransactionalEmailDefinitiveError('No sender');
  });
  assert.equal(failed.delivery, 'failed');
});

test('invite delivery reclaims a crashed SENDING claim after its lease and retries UNKNOWN only explicitly', async () => {
  const owner = await user();
  const id = String((await team(owner)).id);
  let sends = 0;
  const sender = async () => {
    sends++;
    return { id: `receipt-${sends}` };
  };
  const stuckEmail = `stuck-${randomUUID()}@example.test`;
  const stuck = await prisma.teamMember.create({
    data: { teamId: id, email: stuckEmail, inviteDeliveryStatus: 'SENDING' },
  });
  const fresh = await service.inviteMember(owner.userId, id, stuckEmail, sender);
  assert.equal(fresh.delivery, 'sending', 'a live SENDING claim is not duplicated');
  assert.equal(sends, 0);
  const expired = new Date(Date.now() - INVITE_SENDING_LEASE_MS - 1000);
  await prisma.$executeRaw`UPDATE "TeamMember" SET "updatedAt" = ${expired} WHERE "id" = ${stuck.id}`;
  const reclaimed = await service.inviteMember(owner.userId, id, stuckEmail, sender);
  assert.equal(reclaimed.delivery, 'sent');
  assert.equal(sends, 1);
  const uncertainEmail = `uncertain-${randomUUID()}@example.test`;
  const uncertain = await service.inviteMember(owner.userId, id, uncertainEmail, async () => {
    throw new Error('Connection lost after submit');
  });
  assert.equal(uncertain.delivery, 'unknown');
  await request(owner, `/${id}/invites`, 'POST', { email: uncertainEmail, retry: 'yes' }, 400);
  await service.inviteMember(owner.userId, id, uncertainEmail, sender);
  assert.equal(sends, 1, 'a plain re-invite never resends a possibly delivered email');
  const retried = await service.inviteMember(owner.userId, id, uncertainEmail, sender, true);
  assert.equal(retried.delivery, 'sent', 'explicit owner retry reclaims UNKNOWN');
  assert.equal(sends, 2);
  await prisma.teamMember.updateMany({
    where: { teamId: id, email: uncertainEmail },
    data: { inviteDeliveryStatus: 'UNKNOWN' },
  });
  const hashOf = async () =>
    (await prisma.teamMember.findFirstOrThrow({ where: { teamId: id, email: uncertainEmail } }))
      .inviteTokenHash;
  const before = await hashOf();
  await request(owner, `/${id}/invites`, 'POST', { email: uncertainEmail }, 201);
  assert.equal(await hashOf(), before, 'HTTP re-invite without retry does not reclaim UNKNOWN');
  await request(owner, `/${id}/invites`, 'POST', { email: uncertainEmail, retry: true }, 201);
  assert.notEqual(await hashOf(), before, 'HTTP retry=true claims a new delivery');
  const member = await user();
  await request(owner, `/${id}/invites`, 'POST', { email: member.email }, 201);
  await request(member, `/${id}/invites`, 'POST', { email: uncertainEmail, retry: true }, 404);
});

test('mailbox proof is required for normal acceptance, stored hashed, and consumed once', async () => {
  const owner = await user();
  const member = await user();
  const outsider = await user();
  const id = String((await team(owner)).id);
  let invitationToken = '';
  const sent = await service.inviteMember(owner.userId, id, member.email, async (input) => {
    const url = input.body.split('\n').find((line) => line.includes('team-invite-token='));
    assert(url);
    invitationToken =
      new URLSearchParams(new URL(url).hash.slice(1)).get('team-invite-token') ?? '';
    return { id: 'mail-proof' };
  });
  const stored = await prisma.teamMember.findUniqueOrThrow({ where: { id: sent.member.id } });
  assert.equal(stored.inviteTokenHash?.length, 64);
  assert.notEqual(stored.inviteTokenHash, invitationToken);
  assert(!JSON.stringify(sent).includes(invitationToken));
  await assert.rejects(service.acceptInvite(member.userId, id), { status: 403 });
  await assert.rejects(service.acceptInvite(member.userId, id, 'wrong-token'), { status: 403 });
  await assert.rejects(service.acceptInvite(outsider.userId, id, invitationToken), { status: 404 });
  assert(process.env.SUPABASE_JWT_SECRET);
  const auth = jwt.sign(
    {
      sub: member.userId,
      email: member.email,
      role: 'authenticated',
      aud: 'authenticated',
      is_anonymous: false,
    },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h', issuer: `${process.env.SUPABASE_URL}/auth/v1` }
  );
  expectStatus(
    await call(`/api/teams/${id}/accept`, { method: 'POST', auth, body: {} }),
    403,
    'real session requires mailbox proof'
  );
  expectStatus(
    await call(`/api/teams/${id}/accept`, { method: 'POST', auth, body: { token: 'wrong' } }),
    403,
    'real session rejects wrong proof'
  );
  expectStatus(
    await call(`/api/teams/${id}/accept`, {
      method: 'POST',
      auth,
      body: { token: invitationToken },
    }),
    200,
    'real session accepts mailed proof'
  );
  assert.equal(
    (await prisma.teamMember.findUniqueOrThrow({ where: { id: sent.member.id } })).inviteTokenHash,
    null
  );
  await service.acceptInvite(member.userId, id);
});

test('first-team bootstrap requires exact owner identity and is idempotent', async () => {
  const owner = await user();
  const member = await user();
  let count = 0;
  const send = async () => {
    count++;
    return { id: 'bootstrap-invite' };
  };
  await assert.rejects(
    service.bootstrapTeam(owner.userId, member.email, 'Rose Labs', member.email, send),
    { status: 409 }
  );
  const first = await service.bootstrapTeam(
    owner.userId,
    owner.email,
    'Rose Labs',
    member.email,
    send
  );
  const second = await service.bootstrapTeam(
    owner.userId,
    owner.email,
    'Rose Labs',
    member.email,
    send
  );
  assert.equal(first.team.id, second.team.id);
  assert.equal(
    await prisma.team.count({ where: { ownerUserId: owner.userId, name: 'Rose Labs' } }),
    1
  );
  assert.equal(count, 1);
  assert.equal(second.invitation.member.status, 'INVITED');
  assert.deepEqual(second.team.integrationShares, []);
});

test('phone-only owner and newly invited phone-only member need no fabricated email', async () => {
  const owner = await user('Phone owner');
  const member = await user('Phone member');
  await prisma.user.updateMany({
    where: { userId: { in: [owner.userId, member.userId] } },
    data: { email: null },
  });
  const created = await team(owner, 'Phone team');
  assert.equal((created.members as Array<{ email: string | null }>)[0].email, null);
  const id = String(created.id);
  const recipient = `new-mailbox-${randomUUID()}@example.test`;
  let token = '';
  const send = async (input: { body: string }) => {
    const url = input.body.split('\n').find((line) => line.includes('team-invite-token='));
    assert(url);
    token = new URLSearchParams(new URL(url).hash.slice(1)).get('team-invite-token') ?? '';
    return { id: 'phone-member-invite' };
  };
  const invitation = await service.inviteMember(owner.userId, id, recipient, send);
  assert.equal(invitation.member.userId, null);
  assert.equal(invitation.member.onRose, false);
  assert(process.env.SUPABASE_JWT_SECRET);
  const auth = jwt.sign(
    { sub: member.userId, role: 'authenticated', aud: 'authenticated', is_anonymous: false },
    process.env.SUPABASE_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '1h', issuer: `${process.env.SUPABASE_URL}/auth/v1` }
  );
  expectStatus(
    await call(`/api/teams/${id}/invitation`, { method: 'POST', auth, body: { token: 'wrong' } }),
    404,
    'preview rejects wrong token'
  );
  const preview = await call(`/api/teams/${id}/invitation`, {
    method: 'POST',
    auth,
    body: { token },
  });
  expectStatus(preview, 200, 'phone account previews mailed invite');
  assert.deepEqual(preview.data.members, []);
  expectStatus(
    await call(`/api/teams/${id}/accept`, { method: 'POST', auth, body: {} }),
    403,
    'phone account still needs proof'
  );
  expectStatus(
    await call(`/api/teams/${id}/accept`, { method: 'POST', auth, body: { token } }),
    200,
    'phone account accepts proof'
  );
  assert.equal(
    (await prisma.user.findUniqueOrThrow({ where: { userId: member.userId } })).email,
    null
  );
  const staleEmailMatch = await user();
  await prisma.user.update({
    where: { userId: staleEmailMatch.userId },
    data: { email: recipient },
  });
  const first = await service.bootstrapTeam(owner.userId, undefined, 'Rose Labs', recipient, send);
  const second = await service.bootstrapTeam(owner.userId, undefined, 'Rose Labs', recipient, send);
  assert.equal(first.team.id, second.team.id);
  assert.equal(first.team.members[0].email, null);
  assert.equal(first.invitation.member.userId, staleEmailMatch.userId);
  await assert.rejects(
    service.acceptInvite(member.userId, first.team.id, token),
    (error: { status?: number }) => error.status === 403,
    'a leaked token cannot move an invitation bound to another account to an email-less caller'
  );
  const bound = await prisma.teamMember.findUniqueOrThrow({
    where: { id: first.invitation.member.id },
  });
  assert.equal(bound.status, 'INVITED');
  assert.equal(bound.userId, staleEmailMatch.userId);
  await service.acceptInvite(staleEmailMatch.userId, first.team.id, token);
  assert.equal(
    (await prisma.teamMember.findUniqueOrThrow({ where: { id: first.invitation.member.id } }))
      .status,
    'ACCEPTED',
    'the bound account accepts with the mailed token'
  );
});

test('committed migration applies to existing prerequisites with RLS, checks, and cascading revocation', () => {
  const schema = `teams_migration_${randomUUID().replace(/-/g, '')}`;
  const migration = readFileSync(
    new URL('../../../prisma/migrations/20261111073000_teams/migration.sql', import.meta.url),
    'utf8'
  );
  const url = new URL(process.env.DATABASE_URL!);
  url.search = '';
  const result = spawnSync('psql', [url.toString(), '-X', '-v', 'ON_ERROR_STOP=1'], {
    encoding: 'utf8',
    input: `
BEGIN;
CREATE SCHEMA "${schema}";
SET LOCAL search_path TO "${schema}", public;
CREATE TABLE "User" ("userId" TEXT PRIMARY KEY);
CREATE TABLE "Integration" ("id" TEXT PRIMARY KEY);
CREATE TABLE "Project" ("id" TEXT PRIMARY KEY);
${migration}
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relrowsecurity) <> 4 THEN
    RAISE EXCEPTION 'Expected RLS on all four team tables';
  END IF;
END $$;
INSERT INTO "User" VALUES ('owner'), ('member');
INSERT INTO "Integration" VALUES ('inbox');
INSERT INTO "Project" VALUES ('project');
INSERT INTO "Team" ("id", "name", "ownerUserId", "updatedAt") VALUES ('team', 'Team', 'owner', now());
INSERT INTO "TeamMember" ("id", "teamId", "userId", "email", "status", "updatedAt") VALUES ('member', 'team', 'member', 'member@example.test', 'ACCEPTED', now());
INSERT INTO "TeamMember" ("id", "teamId", "userId", "email", "role", "status", "updatedAt") VALUES ('owner-member', 'team', 'owner', NULL, 'OWNER', 'ACCEPTED', now());
INSERT INTO "TeamIntegrationShare" ("id", "teamId", "integrationId", "ownerUserId", "provider") VALUES ('grant', 'team', 'inbox', 'owner', 'gmail');
INSERT INTO "TeamProjectShare" ("id", "teamId", "projectId", "ownerUserId") VALUES ('share', 'team', 'project', 'owner');
DELETE FROM "TeamMember" WHERE "id"='owner-member';
DO $$ BEGIN
  IF EXISTS(SELECT FROM "TeamIntegrationShare") OR EXISTS(SELECT FROM "TeamProjectShare") THEN
    RAISE EXCEPTION 'Revoked membership left grants behind';
  END IF;
END $$;
DELETE FROM "Team" WHERE "id"='team';
DO $$ BEGIN
  IF EXISTS(SELECT FROM "TeamMember") OR EXISTS(SELECT FROM "TeamIntegrationShare") OR EXISTS(SELECT FROM "TeamProjectShare") THEN
    RAISE EXCEPTION 'Cascade left team access behind';
  END IF;
END $$;
ROLLBACK;`,
  });
  assert.equal(result.status, 0, result.stderr);
});
