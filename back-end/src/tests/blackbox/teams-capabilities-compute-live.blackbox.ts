#!/usr/bin/env tsx
/**
 * REAL run: a teammate's Rose completion is served by the owner's team-shared
 * Codex (ChatGPT) subscription.
 *
 *   runner syncs this box's ~/.codex/auth.json (scripts/sync-codex-token.ts)
 *     └► its encrypted credential is copied onto a synthetic owner's gpt_code account
 *         └► owner shares it with the team (real /api/teams route)
 *             └► teammate with NO compute leases via the real token route (source "team")
 *                 └► real createStreamingCompletion on the Codex subscription leg only
 *                     (disable_waterfall; actual_model "<gptAuthModel>-gpt")
 *   unshare ─► the same lease no longer names the owner's account
 *
 * Hosts with no subscription login at all (CI/Linux gate VMs: no ChatGPT-mode ~/.codex/auth.json)
 * skip with that explicit reason, like the deploy's approved Claude Code smoke skip; the stubbed
 * teams-capabilities-compute suite asserts the same behavior in every gate. A host that HAS the
 * login but no synced credential fails with the exact fix.
 * Cost: one tiny low-effort prompt on the ChatGPT subscription per run.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prisma } from '../../providers/database';
import { createStreamingCompletion } from '../../providers/rose/client';
import { getPool } from '../../providers/rose/pools';
import { fetchComputeTokenForUser } from '../../providers/computeCredentials';
import { apiKeyHeaders, call, expectStatus } from './projects-harness';
import { randomUUID, share, teamFixture, unshare } from './teams-capabilities.harness';

/** The user scripts/sync-codex-token.ts seeds (its CODEX_TOKEN_USER_ID default). */
const SYNCED_USER_ID = process.env.CODEX_TOKEN_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';

/** Whether this host has a ChatGPT-mode Codex login the runner would sync. */
function hostHasCodexSubscription(): boolean {
  try {
    const path = process.env.CODEX_AUTH_PATH ?? join(homedir(), '.codex', 'auth.json');
    return (
      (JSON.parse(readFileSync(path, 'utf8')) as { auth_mode?: unknown }).auth_mode === 'chatgpt'
    );
  } catch {
    return false;
  }
}

async function syncedCodexCredential(): Promise<string> {
  const rows = await prisma.integration.findMany({
    where: { userId: SYNCED_USER_ID, name: 'gpt_code', status: 'CONNECTED' },
    orderBy: { updatedAt: 'desc' },
    select: { config: true },
  });
  for (const row of rows) {
    const sealed = (row.config as { encryptedCredentials?: unknown } | null)?.encryptedCredentials;
    if (typeof sealed === 'string' && sealed !== '') return sealed;
  }
  throw new Error(
    `No real Codex credential is synced into the test database for user ${SYNCED_USER_ID}. ` +
      'Fix: on this box run `codex login` (ChatGPT mode, ~/.codex/auth.json auth_mode=chatgpt), ' +
      'then run scripts/run-blackbox-tests.sh WITHOUT BACKEND_CODEX_TOKEN_SYNC_SKIP=1 so ' +
      'scripts/sync-codex-token.ts seeds it.'
  );
}

type Lease = {
  type: string;
  source: string;
  accessToken: string;
  accountId?: string;
  integrationId?: string;
  ownerUserId?: string;
  teamId?: string;
} | null;

async function gptLease(userId: string): Promise<Lease> {
  const res = await call('/api/integrations/compute-code/credentials/token?tokenType=gpt', {
    headers: apiKeyHeaders(userId),
  });
  if (res.status === 404) return null;
  expectStatus(res, 200, 'compute lease');
  return res.data as Lease;
}

test("a teammate's real Rose completion runs on the owner's shared Codex subscription", async (t) => {
  if (!hostHasCodexSubscription()) {
    t.skip(
      'no ChatGPT-mode Codex login on this host (CI/Linux gate VM); the live team-compute proof ' +
        'runs where `codex login` exists, and teams-capabilities-compute asserts the behavior here'
    );
    return;
  }
  const sealed = await syncedCodexCredential();
  const f = await teamFixture('compute-live');
  const owned = await prisma.integration.create({
    data: {
      userId: f.owner.userId,
      name: 'gpt_code',
      accountId: `teamcap-live-${randomUUID()}`,
      type: 'TOOL_SETUP',
      status: 'CONNECTED',
      isActive: true,
      poolingEnabled: false,
      config: { encryptedCredentials: sealed },
    },
  });
  assert.equal(
    await prisma.integration.count({ where: { userId: f.reader.userId, name: 'gpt_code' } }),
    0,
    'the teammate has no compute of their own'
  );
  await share(f, owned.id);

  const lease = await gptLease(f.reader.userId);
  assert.equal(lease?.source, 'team', JSON.stringify(lease?.source));
  assert.equal(lease?.ownerUserId, f.owner.userId);
  assert.equal(lease?.integrationId, owned.id);
  assert.equal(lease?.teamId, f.teamId);
  assert.ok(lease?.accessToken, 'a real access token');

  const pool = getPool('rose-1-mini');
  const stream = await createStreamingCompletion({
    model: 'rose-labs/rose-1-mini',
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    gpt_token: lease.accessToken,
    gpt_account_id: lease.accountId,
    effort: 'low',
    // Only the subscription leg may answer: no funded-key fallback can fake a pass.
    disable_waterfall: true,
  });
  let text = '';
  let actualModel = '';
  let poolName = '';
  let usage: unknown = null;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content ?? '';
    actualModel ||= chunk.actual_model;
    poolName ||= chunk.pool_name;
    usage = chunk.usage ?? usage;
  }
  console.log(
    `[teams-capabilities-compute-live] actual_model=${actualModel} pool_name=${poolName} ` +
      `chars=${text.length} usage=${JSON.stringify(usage)}`
  );
  assert.ok(text.trim().length > 0, 'a non-empty real response');
  assert.equal(actualModel, `${pool.gptAuthModel}-gpt`, 'served by the ChatGPT subscription leg');
  assert.equal(poolName, 'gpt-token', 'the subscription-token leg (gptAuth.ts), not a funded pool');

  await unshare(f, owned.id);
  const revoked = await gptLease(f.reader.userId);
  assert.notEqual(revoked?.source, 'team');
  assert.notEqual(revoked?.integrationId, owned.id, "the owner's account is no longer leased");
  const inProcess = await fetchComputeTokenForUser(f.reader.userId, { tokenType: 'gpt' });
  assert.notEqual(inProcess?.integrationId, owned.id);
});
