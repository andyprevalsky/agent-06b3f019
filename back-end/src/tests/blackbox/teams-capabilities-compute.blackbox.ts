#!/usr/bin/env tsx
/**
 * A teammate's server-side Rose LLM calls lease the owner's team-shared compute
 * subscription (claude_code / gpt_code grant) through the real token route:
 *
 *   own → TEAM (source "team", keyed by the shared integration) → pool → funded
 *
 * The team step comes only after the teammate's own subscription, honours the
 * owner's rateLimitedUntil, is revalidated on every lease reuse (unshare,
 * disconnect, invited-only reader, owner leaving), is never served to a user
 * session, and never reaches a sandbox or Mac credential resolver.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { credentialFingerprint } from '../../providers/codeLoginRejection';
import { fetchClaudeCodeCredentialsWithMeta } from '../../providers/claudeCredentials';
import { fetchGptCodeCredentialsWithMeta } from '../../providers/gptCredentials';
import { fetchComputeTokenForUser } from '../../providers/computeCredentials';
import { generateSupabaseSession } from '../../providers/sessionTokens';
import { apiKeyHeaders, call, expectStatus } from './projects-harness';
import {
  ownerLeaves,
  randomUUID,
  seedCompute,
  share,
  teamFixture,
  unshare,
} from './teams-capabilities.harness';

type Lease = {
  type?: string;
  source?: string;
  accessToken?: string;
  integrationId?: string;
  ownerUserId?: string;
  teamId?: string;
  lineageKey?: string;
};

async function lease(
  userId: string,
  tokenType: 'claude' | 'gpt',
  params: Record<string, string> = {},
  headers: Record<string, string> = apiKeyHeaders(userId)
): Promise<Lease | null> {
  const query = new URLSearchParams({ tokenType, ...params });
  const res = await call(`/api/integrations/compute-code/credentials/token?${query}`, { headers });
  if (res.status === 404) return null;
  expectStatus(res, 200, 'compute lease');
  return res.data as Lease;
}

/** True when the reader's lease is the owner's shared token (any other source is not). */
async function servedTeam(userId: string, type: 'claude' | 'gpt', ownerToken: string) {
  const served = await lease(userId, type);
  const isTeam = served?.source === 'team';
  assert.equal(isTeam, served?.accessToken === ownerToken, JSON.stringify(served?.source));
  return isTeam;
}

for (const [name, type] of [
  ['claude_code', 'claude'],
  ['gpt_code', 'gpt'],
] as const) {
  test(`${name}: team lease only after own, honours owner cooldown, observable`, async () => {
    const f = await teamFixture(`compute-${type}`);
    const shared = await seedCompute(f.owner.userId, name);
    assert.equal(await servedTeam(f.reader.userId, type, shared.accessToken), false, 'unshared');
    await share(f, shared.id);

    const served = await lease(f.reader.userId, type);
    assert.equal(served?.source, 'team');
    assert.equal(served?.accessToken, shared.accessToken);
    assert.equal(served?.integrationId, shared.id);
    assert.equal(served?.ownerUserId, f.owner.userId, 'which owner served the call');
    assert.equal(served?.teamId, f.teamId);

    // The teammate's own subscription always wins; the team step follows it.
    const own = await seedCompute(f.reader.userId, name);
    assert.equal((await lease(f.reader.userId, type))?.accessToken, own.accessToken);
    await prisma.integration.update({
      where: { id: own.id },
      data: { rateLimitedUntil: new Date(Date.now() + 600_000) },
    });
    assert.equal((await lease(f.reader.userId, type))?.source, 'team', 'own cooling down');

    // A lineage lease is keyed by the shared integration and reused while the share holds.
    const lineageKey = `teamcap:${randomUUID()}`;
    const agentId = randomUUID();
    const leased = await lease(f.reader.userId, type, { lineageKey, agentId });
    assert.equal(leased?.source, 'team');
    assert.equal(leased?.lineageKey, lineageKey);
    const row = await prisma.computeTokenLineageLease.findUniqueOrThrow({ where: { lineageKey } });
    assert.equal(row.tokenSource, 'team');
    assert.equal(row.tokenIdentity, shared.id);
    assert.equal((await lease(f.reader.userId, type, { lineageKey, agentId }))?.source, 'team');

    // The owner's cooldown applies to teammates: a report on the team lease marks it.
    const report = {
      type,
      source: 'team',
      userId: f.reader.userId,
      integrationId: shared.id,
      rateLimitedUntil: new Date(Date.now() + 600_000).toISOString(),
      // Provider-supplied reset: no background usage refresh against the fixture token.
      rateLimitAuthoritative: true,
      credential: credentialFingerprint(shared.accessToken),
    };
    expectStatus(
      await call('/api/integrations/compute-code/token/rate-limited', {
        method: 'POST',
        headers: apiKeyHeaders(f.outsider.userId),
        body: { ...report, userId: f.outsider.userId },
      }),
      400,
      'a non-member cannot cool down the owner account'
    );
    const before = await prisma.integration.findUniqueOrThrow({ where: { id: shared.id } });
    assert.equal(before.rateLimitedUntil, null);
    expectStatus(
      await call('/api/integrations/compute-code/token/rate-limited', {
        method: 'POST',
        headers: apiKeyHeaders(f.reader.userId),
        body: report,
      }),
      200,
      'team cooldown report'
    );
    const cooled = await prisma.integration.findUniqueOrThrow({ where: { id: shared.id } });
    assert.ok(cooled.rateLimitedUntil !== null && cooled.rateLimitedUntil > new Date());
    assert.equal(await servedTeam(f.reader.userId, type, shared.accessToken), false, 'cooldown');
    const reused = await lease(f.reader.userId, type, { lineageKey, agentId });
    assert.notEqual(reused?.accessToken, shared.accessToken, 'a cooled lease is not reused');
  });
}

test('revocation is immediate: unshare, invited-only, non-member, disconnect, owner leaving', async () => {
  const f = await teamFixture('compute-revoke');
  const shared = await seedCompute(f.owner.userId, 'claude_code');
  const team = () => servedTeam(f.reader.userId, 'claude', shared.accessToken);
  await share(f, shared.id);
  const lineageKey = `teamcap:${randomUUID()}`;
  const agentId = randomUUID();
  assert.equal((await lease(f.reader.userId, 'claude', { lineageKey, agentId }))?.source, 'team');

  assert.equal(await servedTeam(f.invited.userId, 'claude', shared.accessToken), false, 'invited');
  assert.equal(
    await servedTeam(f.outsider.userId, 'claude', shared.accessToken),
    false,
    'outsider'
  );
  assert.equal(await servedTeam(f.lead.userId, 'claude', shared.accessToken), true, 'any member');

  await unshare(f, shared.id);
  assert.equal(await team(), false, 'unshared');
  const afterUnshare = await lease(f.reader.userId, 'claude', { lineageKey, agentId });
  assert.notEqual(afterUnshare?.accessToken, shared.accessToken, 'a live lease ends on unshare');

  await share(f, shared.id);
  assert.equal(await team(), true);
  await prisma.integration.update({ where: { id: shared.id }, data: { status: 'NOT_CONNECTED' } });
  assert.equal(await team(), false, 'owner disconnected');
  await prisma.integration.update({ where: { id: shared.id }, data: { status: 'CONNECTED' } });
  assert.equal(await team(), true);

  await ownerLeaves(f);
  assert.equal(await team(), false, 'owner left the team');
});

test('shared compute never reaches a user session, a sandbox or a Mac resolver', async () => {
  const f = await teamFixture('compute-boundary');
  const claude = await seedCompute(f.owner.userId, 'claude_code');
  const gpt = await seedCompute(f.owner.userId, 'gpt_code');
  await share(f, claude.id);
  await share(f, gpt.id);
  assert.equal((await lease(f.reader.userId, 'claude'))?.source, 'team', 'internal Rose call');

  // A user session (or anything it hands a token to) never gets the team step.
  const session = generateSupabaseSession(f.reader.userId, '').access_token;
  for (const [type, owner] of [
    ['claude', claude],
    ['gpt', gpt],
  ] as const) {
    const viaUser = await lease(f.reader.userId, type, {}, { Authorization: `Bearer ${session}` });
    assert.notEqual(viaUser?.source, 'team');
    assert.notEqual(viaUser?.accessToken, owner.accessToken);
  }

  // Sandbox (e2b) and Mac (localDevices) sessions resolve credentials only here.
  const sandboxClaude = await fetchClaudeCodeCredentialsWithMeta(f.reader.userId);
  const sandboxGpt = await fetchGptCodeCredentialsWithMeta(f.reader.userId);
  for (const credential of [sandboxClaude, sandboxGpt]) {
    const text = JSON.stringify(credential ?? null);
    assert.ok(
      !text.includes(claude.accessToken) && !text.includes(gpt.accessToken),
      text.slice(0, 80)
    );
  }

  // In-process Rose completions (chat, SMS, Rose leases) do get it, after own.
  assert.equal(
    (await fetchComputeTokenForUser(f.reader.userId, { tokenType: 'gpt' }))?.source,
    'team'
  );
  const optOut = await fetchComputeTokenForUser(f.reader.userId, {
    tokenType: 'gpt',
    includeTeam: false,
  });
  assert.notEqual(optOut?.accessToken, gpt.accessToken);
});
