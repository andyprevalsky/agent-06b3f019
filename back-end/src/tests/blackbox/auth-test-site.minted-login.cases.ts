/**
 * Rose Shop fixtures whose minted identity already has an account seed that
 * account as the passwordless saved login production records after a minted
 * sign-in. These cases prove the fixture state is the state the real pipeline
 * produces, so a benchmark never grades the agent on a state prod cannot reach.
 */

import { prisma } from '../../providers/database';
import { getAuthOptions } from '../../domains/auth-options/service';
import { canonicalAuthRealm } from '../../providers/authRealm';
import { propagateBrowserRunCredentials } from '../../providers/credentialPropagation';
import {
  assert,
  cleanup,
  createFixture,
  createMintedIdentity,
  createUser,
  decryptEnvelope,
  test,
  withLocalSite,
  type Manifest,
} from './auth-test-site.testkit';

async function seed(base: string, userId: string, scenario: string): Promise<Manifest> {
  const created = await createFixture(base, { userId, scenario, publicBaseUrl: base });
  assert(created.status === 201, `${scenario} fixture expected 201, got ${created.status}`);
  return (await created.json()) as Manifest;
}

/** Runs the real post-run propagation for one successful minted sign-in. */
async function recordMintedSignIn(
  userId: string,
  url: string,
  typed: string,
  identityEmail: string
): Promise<void> {
  const agent = await prisma.agent.create({
    data: { userId, goal: 'Tell me my member number', status: 'COMPLETED' },
  });
  const minted = await prisma.mintedAccount.create({
    data: { userId, authRealm: canonicalAuthRealm(url), accountLabel: identityEmail },
  });
  const taskId = `browser-task-${agent.id}`;
  await prisma.message.create({
    data: {
      agentId: agent.id,
      role: 'TOOL',
      text: 'Typed the sign-in identifier',
      metadata: {
        task_id: taskId,
        credential_ref: { kind: 'minted_account', id: minted.id, username: typed, origin: url },
      },
    },
  });
  const previous = process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE;
  process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE = JSON.stringify({
    reason: 'signed in with a texted code',
    credentialOutcomes: [{ kind: 'minted', id: minted.id, outcome: 'success', reason: 'ok' }],
  });
  try {
    await propagateBrowserRunCredentials({
      agentId: agent.id,
      taskId,
      success: true,
      status: 'completed',
      message: 'done',
    });
  } finally {
    if (previous === undefined) delete process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE;
    else process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE = previous;
    await prisma.agentRunCredentialPropagation.deleteMany({ where: { agentId: agent.id } });
    await prisma.message.deleteMany({ where: { agentId: agent.id } });
    await prisma.agent.deleteMany({ where: { id: agent.id } });
  }
}

async function loginState(userId: string, url: string, identifier: string) {
  // Each user's own minted identifier compares equal; everything else must match exactly.
  const own = (value: string) => (value === identifier ? '<minted identifier>' : value);
  const rows = await prisma.browserPassword.findMany({ where: { userId } });
  const options = await getAuthOptions(userId, url);
  return {
    rows: rows.map((row) => ({
      username: own(row.username),
      browserSource: row.browserSource,
      password: decryptEnvelope(row.encryptedPassword),
      realm: canonicalAuthRealm(row.origin),
    })),
    minted: options.minted,
    passwords: options.passwords.map((p) => ({
      username: own(p.username),
      browserSource: p.browserSource,
      disabled: p.disabled,
    })),
    readable: options.readable_identifiers.includes(identifier),
  };
}

for (const [scenario, identifier] of [
  ['minted_sms_otp', 'phone'],
  ['minted_otp', 'email'],
] as const) {
  test(`${scenario}: the seeded minted login is the one a real minted sign-in records`, async () => {
    const fixtureUser = await createUser();
    const pipelineUser = await createUser();
    try {
      const minted = await createMintedIdentity(fixtureUser, '+15555550142');
      const other = await createMintedIdentity(pipelineUser, '+15555550143');
      await withLocalSite(async ({ base }) => {
        const manifest = await seed(base, fixtureUser, scenario);
        const typed = identifier === 'phone' ? minted.phone : minted.email;
        const seeded = await loginState(fixtureUser, manifest.entryUrl, typed);
        assert(
          seeded.rows.length === 1 && seeded.rows[0]?.username === '<minted identifier>',
          `the fixture seeds one login under the minted ${identifier}: ${JSON.stringify(seeded.rows)}`
        );
        assert(seeded.minted === null, 'a recorded minted login hides Minted');
        assert(seeded.readable, 'the recorded identifier is one whose codes reach the agent');

        const pipelineTyped = identifier === 'phone' ? other.phone : other.email;
        await recordMintedSignIn(pipelineUser, manifest.entryUrl, pipelineTyped, other.email);
        const produced = await loginState(pipelineUser, manifest.entryUrl, pipelineTyped);
        assert(
          JSON.stringify(produced) === JSON.stringify(seeded),
          `fixture and real pipeline must agree: ${JSON.stringify({ seeded, produced })}`
        );
      });
    } finally {
      await cleanup(fixtureUser);
      await cleanup(pipelineUser);
    }
  });
}
