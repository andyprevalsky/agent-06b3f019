#!/usr/bin/env tsx
/**
 * Every integration except iPhone, browser cookies, passwords and Pebble Index 01 is shareable by exact
 * account, and every grant is revalidated at read time. Discovered by run.ts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import * as service from '../../domains/teams/service';
import { user, request, team, join, type User } from './teams-harness';

interface Listed {
  id: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  label: string | null;
  teamIds: string[];
}

async function integration(
  u: User,
  name: string,
  data: {
    accountId?: string;
    accountEmail?: string;
    type?: 'DATA_SOURCE' | 'TOOL_SETUP';
    config?: object;
  } = {}
) {
  return prisma.integration.create({
    data: {
      userId: u.userId,
      name,
      accountId: data.accountId ?? '',
      accountEmail: data.accountEmail ?? null,
      type: data.type ?? 'DATA_SOURCE',
      status: 'CONNECTED',
      isActive: true,
      ...(data.config ? { config: data.config } : {}),
    },
  });
}

async function plaidItem(
  u: User,
  integrationId: string,
  institutionName: string,
  status: 'ACTIVE' | 'REQUIRES_REAUTH' = 'ACTIVE'
) {
  return prisma.plaidItem.create({
    data: {
      userId: u.userId,
      integrationId,
      plaidItemId: `item-${randomUUID()}`,
      institutionName,
      encryptedAccessToken: 'not-a-real-token',
      status,
    },
  });
}

/** One owner with every shareable provider connected, plus the excluded ones. */
async function connectEverything(owner: User) {
  const rows = {
    whatsapp: await integration(owner, 'whatsapp'),
    linkedin: await integration(owner, 'linkedin'),
    granola: await integration(owner, 'granola', { accountEmail: 'Notes@Example.test' }),
    fireflies: await integration(owner, 'fireflies', { accountEmail: 'calls@example.test' }),
    plaid: await integration(owner, 'plaid'),
    repo: await integration(owner, 'github_repo', { accountId: 'gh:acme/app', type: 'TOOL_SETUP' }),
    claude: await integration(owner, 'claude_code', {
      accountId: 'claude-acct',
      accountEmail: 'claude@example.test',
      type: 'TOOL_SETUP',
    }),
    codex: await integration(owner, 'gpt_code', {
      accountId: 'codex-acct',
      accountEmail: 'codex@example.test',
      type: 'TOOL_SETUP',
    }),
    cli: await integration(owner, 'cli', {
      accountId: `cli-${randomUUID()}`,
      type: 'TOOL_SETUP',
      config: { kind: 'cli-template-v1', request: 'vercel', name: 'Vercel CLI', agent_id: 'agent' },
    }),
    mcp: await integration(owner, 'mcp', {
      accountId: 'https://mcp.example.test/mcp',
      type: 'TOOL_SETUP',
      config: {
        kind: 'mcp-server-v1',
        name: 'Docs MCP',
        slug: 'docs-mcp',
        url: 'https://mcp.example.test/mcp',
        auth: 'none',
        tools: [],
      },
    }),
  };
  // Never shareable, even when connected.
  for (const name of ['iphone', 'chrome', 'apple_passwords', 'pebble_index'])
    await integration(owner, name, { accountId: name === 'chrome' ? 'default' : '' });
  const chase = await plaidItem(owner, rows.plaid.id, 'Chase');
  const amex = await plaidItem(owner, rows.plaid.id, 'Amex');
  const stale = await plaidItem(owner, rows.plaid.id, 'Stale Bank', 'REQUIRES_REAUTH');
  return { rows, chase, amex, stale };
}

test('every provider except iPhone, browser cookies, passwords and Pebble lists exact shareable accounts', async () => {
  const owner = await user('Owner');
  const { chase, amex, stale } = await connectEverything(owner);
  const listed = (await request(owner, '/shareable-integrations')).integrations as Listed[];
  const byKey = new Map(listed.map((row) => [`${row.provider}:${row.accountId}`, row]));
  assert.deepEqual([...new Set(listed.map((row) => row.provider))].sort(), [
    'claude_code',
    'cli',
    'fireflies',
    'github_repo',
    'gpt_code',
    'granola',
    'linkedin',
    'mcp',
    'plaid',
    'whatsapp',
  ]);
  for (const excluded of ['iphone', 'chrome', 'apple_passwords', 'pebble_index'])
    assert.equal(
      listed.some((row) => row.provider === excluded),
      false,
      `${excluded} must never be shareable`
    );
  assert.equal(byKey.get('whatsapp:')?.label, null);
  assert.equal(byKey.get('granola:')?.accountEmail, 'notes@example.test');
  assert.equal(byKey.get('granola:')?.label, 'Notes@Example.test');
  assert.equal(byKey.get(`plaid:${chase.id}`)?.label, 'Chase');
  assert.equal(byKey.get(`plaid:${amex.id}`)?.id, amex.id);
  assert.equal(byKey.has(`plaid:${stale.id}`), false, 'an item needing re-auth is not shareable');
  assert.equal(byKey.get('github_repo:gh:acme/app')?.label, 'gh:acme/app');
  assert.equal(byKey.get('claude_code:claude-acct')?.label, 'claude@example.test');
  assert.equal(listed.find((row) => row.provider === 'cli')?.label, 'Vercel CLI');
  assert.equal(byKey.get('mcp:https://mcp.example.test/mcp')?.label, 'Docs MCP');
});

test('shares bind one exact account and are revalidated at read time for every provider', async () => {
  const owner = await user('Owner');
  const member = await user('Member');
  const outsider = await user('Outsider');
  const id = String((await team(owner)).id);
  await join(owner, member, id);
  const { rows, chase, amex } = await connectEverything(owner);
  const listed = (await request(owner, '/shareable-integrations')).integrations as Listed[];
  for (const row of listed.filter((entry) => entry.accountId !== amex.id))
    await request(owner, `/${id}/integrations/${row.id}`, 'PUT', {});
  const grants = await service.resolveTeamDataAccess(member.userId);
  assert.equal(
    grants.length,
    listed.length - 1,
    'every shared account, and only those, is granted'
  );
  assert.equal(
    grants.some((grant) => grant.accountId === amex.id),
    false,
    'a sibling bank login stays private'
  );
  assert.equal(grants.find((grant) => grant.accountId === chase.id)?.label, 'Chase');
  assert.deepEqual(await service.resolveTeamDataAccess(outsider.userId), []);
  const shared = (await request(owner, '/shareable-integrations')).integrations as Listed[];
  assert.deepEqual(shared.find((row) => row.accountId === chase.id)?.teamIds, [id]);

  // Each provider loses access the moment its exact account stops matching the grant.
  await prisma.integration.update({
    where: { id: rows.granola.id },
    data: { accountEmail: 'other@example.test' },
  });
  await prisma.plaidItem.update({ where: { id: chase.id }, data: { status: 'REQUIRES_REAUTH' } });
  await integration(owner, 'whatsapp', { accountId: 'second-device' });
  await prisma.integration.update({
    where: { id: rows.cli.id },
    data: { status: 'NOT_CONNECTED' },
  });
  await prisma.integration.update({ where: { id: rows.repo.id }, data: { isActive: false } });
  await prisma.integration.update({
    where: { id: rows.mcp.id },
    data: { status: 'EXPIRED', isActive: false },
  });
  const remaining = (await service.resolveTeamDataAccess(member.userId))
    .map((grant) => grant.provider)
    .sort();
  assert.deepEqual(remaining, ['claude_code', 'fireflies', 'gpt_code', 'linkedin']);

  // Unsharing a bank login works by its item id, even after it stopped being shareable.
  await request(owner, `/${id}/integrations/${chase.id}`, 'DELETE', undefined, 204);
  assert.equal(
    await prisma.teamIntegrationShare.count({ where: { teamId: id, accountId: chase.id } }),
    0
  );
  await request(member, `/${id}/integrations/${rows.claude.id}`, 'DELETE', undefined, 404);
});
