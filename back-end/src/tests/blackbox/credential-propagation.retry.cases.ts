/**
 * Credential-propagation cases for runs that tried more than one credential,
 * and for the credential kinds the browser agent records. Registered by
 * credential-propagation.blackbox.ts.
 */

import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { extractCredentialRefs } from '../../providers/credentialPropagationClassifier';
import { propagateBrowserRunCredentials } from '../../providers/credentialPropagation';
import { CEREBRAS_API_URL } from '../../providers/rose/transport';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withMockClassifier<T>(response: unknown, fn: () => Promise<T>): Promise<T> {
  const previous = {
    mock: process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE,
    disabled: process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM,
  };
  process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE = JSON.stringify(response);
  delete process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM;
  try {
    return await fn();
  } finally {
    if (previous.mock === undefined) delete process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE;
    else process.env.CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE = previous.mock;
    if (previous.disabled !== undefined) {
      process.env.CREDENTIAL_PROPAGATION_DISABLE_LLM = previous.disabled;
    }
  }
}

async function withUser(fn: (userId: string) => Promise<void>): Promise<void> {
  const userId = `credential-prop-retry-${randomUUID().slice(0, 12)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  try {
    await fn(userId);
  } finally {
    await prisma.agentRunCredentialPropagation.deleteMany({
      where: { agentId: { contains: userId } },
    });
    await prisma.message.deleteMany({ where: { agent: { userId } } });
    await prisma.agent.deleteMany({ where: { userId } });
    await prisma.browserPassword.deleteMany({ where: { userId } });
    await prisma.mintedAccount.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { userId } });
  }
}

async function savedPassword(userId: string, username: string) {
  return prisma.browserPassword.create({
    data: {
      userId,
      origin: 'https://shop.example/login',
      username,
      encryptedPassword: 'enc',
      browserSource: 'chrome',
    },
  });
}

/**
 * A browser run that signs in on its second saved login completed, so every
 * credential it touched used to be stamped "success": the login the site had
 * just rejected stayed enabled and was offered, and failed, again next run.
 */
async function completedRunDisablesOnlyTheRejectedLogin(): Promise<void> {
  await withUser(async (userId) => {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Tell me my member number', status: 'ACTIVE' },
    });
    const stale = await savedPassword(userId, 'stale@example.com');
    const working = await savedPassword(userId, 'working@example.com');
    const taskId = `browser-task-${randomUUID()}`;
    for (const [text, id] of [
      ['Typed pwd:stale@example.com; the site answered "incorrect password".', stale.id],
      ['Typed pwd:working@example.com; the account page loaded.', working.id],
    ] as const) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          role: 'TOOL',
          text,
          metadata: { task_id: taskId, credential_ref: { kind: 'password', id } },
        },
      });
    }

    const result = await withMockClassifier(
      {
        reason: 'first saved login was rejected, second signed in',
        credentialOutcomes: [
          { kind: 'password', id: stale.id, outcome: 'auth_failed', reason: 'site rejected it' },
          { kind: 'password', id: working.id, outcome: 'success', reason: 'signed in' },
        ],
      },
      () =>
        propagateBrowserRunCredentials({
          agentId: agent.id,
          taskId,
          success: true,
          status: 'completed',
          message: 'Member number RS-1',
        })
    );

    assert(result !== null && result.refs === 2, 'expected both saved logins to be judged');
    const rows = await prisma.browserPassword.findMany({ where: { userId } });
    const disabled = rows.filter((row) => row.disabledAt !== null).map((row) => row.username);
    assert(
      JSON.stringify(disabled) === JSON.stringify(['stale@example.com']),
      `only the rejected login may be disabled, got ${JSON.stringify(disabled)}`
    );
  });
}

/** Tokens the judge model spent thinking on the real two-login run (1,543) before it answered. */
const JUDGE_THINKING_TOKENS = 1500;

function sse(events: unknown[]): Response {
  const lines = [...events.map((event) => `data: ${JSON.stringify(event)}`), 'data: [DONE]'];
  return new Response(`${lines.join('\n\n')}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/**
 * Stands in for the judge model: it thinks first, and thinking counts against
 * the output cap. A cap smaller than the thinking leaves no room for an answer.
 */
function judgeModel(answer: unknown): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url !== CEREBRAS_API_URL) {
      return Promise.resolve(new Response('unavailable in this test', { status: 503 }));
    }
    const body = JSON.parse(String(init?.body)) as { max_completion_tokens?: number };
    const cap = body.max_completion_tokens ?? Number.POSITIVE_INFINITY;
    const thinking = { choices: [{ index: 0, delta: { reasoning: 'weighing each login' } }] };
    if (cap < JUDGE_THINKING_TOKENS) {
      return Promise.resolve(
        sse([thinking, { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }])
      );
    }
    return Promise.resolve(
      sse([
        thinking,
        { choices: [{ index: 0, delta: { content: JSON.stringify(answer) } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ])
    );
  }) as typeof fetch;
}

async function withJudgeModel<T>(answer: unknown, fn: () => Promise<T>): Promise<T> {
  const keys = [
    'CEREBRAS_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE',
    'CREDENTIAL_PROPAGATION_DISABLE_LLM',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  for (const key of keys) delete process.env[key];
  process.env.CEREBRAS_API_KEY = 'blackbox-cerebras-key';
  globalThis.fetch = judgeModel(answer);
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * The judge ran with a 200-token output cap on a model that thinks before it
 * answers, so every call ended with no answer and the run fell back to "all
 * credentials worked": a rejected saved login was never disabled.
 */
async function judgeHasRoomToThinkAndAnswer(): Promise<void> {
  await withUser(async (userId) => {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Tell me my member number', status: 'ACTIVE' },
    });
    const stale = await savedPassword(userId, 'stale@example.com');
    const working = await savedPassword(userId, 'working@example.com');
    const taskId = `browser-task-${randomUUID()}`;
    for (const [text, id] of [
      ['Typed pwd:stale@example.com; the site answered "incorrect password".', stale.id],
      ['Typed pwd:working@example.com; the account page loaded.', working.id],
    ] as const) {
      await prisma.message.create({
        data: {
          agentId: agent.id,
          role: 'TOOL',
          text,
          metadata: { task_id: taskId, credential_ref: { kind: 'password', id } },
        },
      });
    }

    await withJudgeModel(
      {
        reason: 'first saved login was rejected, second signed in',
        credentialOutcomes: [
          { kind: 'password', id: stale.id, outcome: 'auth_failed', reason: 'site rejected it' },
          { kind: 'password', id: working.id, outcome: 'success', reason: 'signed in' },
        ],
      },
      () =>
        propagateBrowserRunCredentials({
          agentId: agent.id,
          taskId,
          success: true,
          status: 'completed',
          message: 'Member number RS-1',
        })
    );

    const rows = await prisma.browserPassword.findMany({ where: { userId } });
    const disabled = rows.filter((row) => row.disabledAt !== null).map((row) => row.username);
    assert(
      JSON.stringify(disabled) === JSON.stringify(['stale@example.com']),
      `the judge's verdict must be applied, got disabled=${JSON.stringify(disabled)}`
    );
  });
}

/** A run that used one credential and completed needs no judge: that credential worked. */
async function completedRunWithOneCredentialSkipsTheJudge(): Promise<void> {
  await withUser(async (userId) => {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Tell me my member number', status: 'ACTIVE' },
    });
    const only = await savedPassword(userId, 'only@example.com');
    await prisma.browserPassword.update({
      where: { id: only.id },
      data: { disabledAt: new Date(), disabledReason: 'earlier failure' },
    });
    const taskId = `browser-task-${randomUUID()}`;
    await prisma.message.create({
      data: {
        agentId: agent.id,
        role: 'TOOL',
        text: 'Typed pwd:only@example.com; the account page loaded.',
        metadata: { task_id: taskId, credential_ref: { kind: 'password', id: only.id } },
      },
    });
    // A judge that would wrongly fail the credential proves it is never consulted.
    await withMockClassifier(
      {
        reason: 'unused',
        credentialOutcomes: [
          { kind: 'password', id: only.id, outcome: 'auth_failed', reason: 'x' },
        ],
      },
      () =>
        propagateBrowserRunCredentials({
          agentId: agent.id,
          taskId,
          success: true,
          status: 'completed',
          message: 'Member number RS-1',
        })
    );
    const row = await prisma.browserPassword.findUniqueOrThrow({ where: { id: only.id } });
    assert(row.disabledAt === null, 'a completed single-credential run re-enables its credential');
  });
}

/** The browser agent records the minted identity as `minted_account`; it must not be dropped. */
function mintedAccountRefsAreRecognized(): Promise<void> {
  const refs = extractCredentialRefs([
    { metadata: { credential_ref: { kind: 'minted_account', id: 'minted-row-1' } } },
    { metadata: { credential_ref: { kind: 'minted', id: 'minted-row-2' } } },
  ]);
  assert(
    JSON.stringify(refs) ===
      JSON.stringify([
        { kind: 'minted', id: 'minted-row-1' },
        { kind: 'minted', id: 'minted-row-2' },
      ]),
    `minted refs must normalize to the stored kind, got ${JSON.stringify(refs)}`
  );
  return Promise.resolve();
}

export const retryCases: Array<{ name: string; fn: () => Promise<void> }> = [
  {
    name: 'completed run that retried saved logins disables only the rejected one',
    fn: completedRunDisablesOnlyTheRejectedLogin,
  },
  {
    name: 'completed run with one credential is not sent to the judge',
    fn: completedRunWithOneCredentialSkipsTheJudge,
  },
  { name: 'minted_account credential refs are recognized', fn: mintedAccountRefsAreRecognized },
  { name: 'the judge has room to think and still answer', fn: judgeHasRoomToThinkAndAnswer },
];
