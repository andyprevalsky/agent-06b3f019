/**
 * Credential-propagation cases for minted identities and passkeys run through
 * the live provider path. Registered by credential-propagation.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { propagateBrowserRunCredentials } from '../../providers/credentialPropagation';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function createUser() {
  const userId = `credential-prop-minted-${randomUUID().slice(0, 12)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.agentRunCredentialPropagation.deleteMany({
    where: { agentId: { contains: userId } },
  });
  await prisma.message.deleteMany({ where: { agent: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.passkeyCredential.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function providerBrowserRunPropagationDisablesAFailedPasskeyEndToEnd(): Promise<void> {
  const userId = await createUser();
  try {
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Sign in with passkey',
        status: 'FAILED',
        statusMessage: 'passkey failed',
      },
    });
    const passkey = await prisma.passkeyCredential.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        rpId: 'amazon.com',
        credentialId: `cred-${randomUUID()}`,
        encryptedPrivateKey: 'enc',
        userHandle: 'uh',
        signCount: 0,
      },
    });
    const taskId = `browser-task-${randomUUID()}`;
    await prisma.message.create({
      data: {
        agentId: agent.id,
        role: 'TOOL',
        text: 'Passkey assertion was rejected',
        metadata: { task_id: taskId, credential_ref: { kind: 'passkey', id: passkey.id } },
      },
    });

    const result = await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'passkey rejected by relying party',
          credentialOutcomes: [
            { kind: 'passkey', id: passkey.id, outcome: 'auth_failed', reason: 'rp rejected' },
          ],
        }),
      },
      () =>
        propagateBrowserRunCredentials({
          agentId: agent.id,
          taskId,
          success: false,
          status: 'failed',
          message: 'passkey failed',
        })
    );

    assert(result !== null, 'expected a propagation decision');
    assert(result.refs === 1, `expected one passkey ref, got ${result.refs}`);
    assert(
      result.credentialOutcomes.some((o) => o.kind === 'passkey' && o.outcome === 'auth_failed'),
      'expected passkey auth_failed outcome'
    );
    const row = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id: passkey.id } });
    assert(row.disabledAt !== null, 'expected provider path to disable the failed passkey');
  } finally {
    await cleanup(userId);
  }
}

async function mintedSignInSuccessSavesTheExactTypedIdentifierAsAPasswordlessLoginThatHidesMinted(): Promise<void> {
  const userId = await createUser();
  try {
    const realm = `passwordless-${randomUUID().slice(0, 8)}.example`;
    const pageUrl = `https://${realm}/login/sms`;
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Tell me my member number', status: 'COMPLETED' },
    });
    const minted = await prisma.mintedAccount.create({
      data: { userId, authRealm: realm, accountLabel: 'rose.agent@mail.example' },
    });
    const taskId = `browser-task-${randomUUID()}`;
    // The email was typed first and rejected; the phone that follows signed in.
    for (const username of ['rose.agent@mail.example', '+15554424867']) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          role: 'TOOL',
          text: 'Typed the sign-in identifier',
          metadata: {
            task_id: taskId,
            credential_ref: { kind: 'minted_account', id: minted.id, username, origin: pageUrl },
          },
        },
      });
    }
    const propagate = (outcome: string) =>
      withEnv(
        {
          CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
          CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
            reason: 'signed in with a texted code',
            credentialOutcomes: [{ kind: 'minted', id: minted.id, outcome, reason: 'signed in' }],
          }),
        },
        () =>
          propagateBrowserRunCredentials({
            agentId: agent.id,
            taskId,
            success: outcome === 'success',
            status: outcome === 'success' ? 'completed' : 'failed',
            message: 'done',
          })
      );

    const result = await propagate('success');
    assert(result !== null && result.refs === 1, 'expected one minted ref');
    const logins = await prisma.browserPassword.findMany({ where: { userId } });
    assert(logins.length === 1, `expected one saved login, got ${logins.length}`);
    assert(
      logins[0].username === '+15554424867',
      `expected the last typed identifier, got ${logins[0].username}`
    );
    assert(
      logins[0].browserSource === 'agent_passwordless',
      `unexpected source ${logins[0].browserSource}`
    );
    assert(logins[0].origin === pageUrl, 'expected the page the identifier was typed on');

    const { getAuthOptions } = await import('../../providers/authOptions');
    const options = await getAuthOptions(userId, realm);
    assert(options.minted === null, 'a saved passwordless login must hide Minted for its site');
    assert(
      options.passwords.some(
        (password) =>
          password.username === '+15554424867' && password.browserSource === 'agent_passwordless'
      ),
      'expected the passwordless login in auth options'
    );
  } finally {
    await cleanup(userId);
  }
}

async function mintedSignInFailureSavesNoPasswordlessLogin(): Promise<void> {
  const userId = await createUser();
  try {
    const realm = `passwordless-${randomUUID().slice(0, 8)}.example`;
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Tell me my member number',
        status: 'FAILED',
        statusMessage: 'no code',
      },
    });
    const minted = await prisma.mintedAccount.create({
      data: { userId, authRealm: realm, accountLabel: 'rose.agent@mail.example' },
    });
    const taskId = `browser-task-${randomUUID()}`;
    await prisma.message.create({
      data: {
        agentId: agent.id,
        role: 'TOOL',
        text: 'Typed the sign-in identifier',
        metadata: {
          task_id: taskId,
          credential_ref: {
            kind: 'minted_account',
            id: minted.id,
            username: '+15554424867',
            origin: `https://${realm}/login`,
          },
        },
      },
    });
    await withEnv(
      {
        CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
        CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
          reason: 'no code arrived',
          credentialOutcomes: [
            { kind: 'minted', id: minted.id, outcome: 'auth_failed', reason: 'no code' },
          ],
        }),
      },
      () =>
        propagateBrowserRunCredentials({
          agentId: agent.id,
          taskId,
          success: false,
          status: 'failed',
          message: 'no code',
        })
    );
    const logins = await prisma.browserPassword.count({ where: { userId } });
    assert(logins === 0, `a failed minted sign-in must not save a login, got ${logins}`);
  } finally {
    await cleanup(userId);
  }
}

export const mintedCases: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 'provider browser-run propagation disables a failed passkey end to end',
    fn: providerBrowserRunPropagationDisablesAFailedPasskeyEndToEnd,
  },
  {
    name: 'minted sign-in success saves the exact typed identifier as a passwordless login that hides Minted',
    fn: mintedSignInSuccessSavesTheExactTypedIdentifierAsAPasswordlessLoginThatHidesMinted,
  },
  {
    name: 'minted sign-in failure saves no passwordless login',
    fn: mintedSignInFailureSavesNoPasswordlessLogin,
  },
];
