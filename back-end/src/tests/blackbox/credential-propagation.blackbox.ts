#!/usr/bin/env tsx

import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { prisma } from '../../providers/database';
import {
  aggregateDecision,
  classifyCredentialOutcomesBestEffort,
  extractCredentialRefs,
} from '../../providers/credentialPropagationClassifier';
import {
  classifierUnavailableDecision,
  classifyFailureBestEffort as classifyDomainFailureBestEffort,
  heuristicDecision as domainHeuristicDecision,
} from '../../domains/credential-propagation/classifier';
import {
  loadAgentForPropagation,
  loadMessagesForPropagation,
  propagateCredentialInTransaction,
  tryCreatePropagationMarker,
} from '../../domains/credential-propagation/repo';
import { retryCases } from './credential-propagation.retry.cases';
import { mintedCases } from './credential-propagation.minted.cases';

config();

type TestFn = () => Promise<void>;

const tests: Array<{ name: string; fn: TestFn }> = [];
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.BACKEND_API_KEY || '';
const RUN_ID =
  process.env.BLACKBOX_TEST_RUN_ID ||
  process.env.CONTRACT_TEST_RUN_ID ||
  `${Date.now()}-${randomUUID().slice(0, 8)}`;

function test(name: string, fn: TestFn) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function createUser() {
  const userId = `credential-prop-${RUN_ID}-${randomUUID().slice(0, 8)}`;
  await prisma.user.create({ data: { userId, isAnonymous: true } });
  return userId;
}

async function cleanup(userId: string) {
  await prisma.agentRunCredentialPropagation.deleteMany({
    where: { agentId: { contains: userId } },
  });
  await prisma.message.deleteMany({ where: { agent: { userId } } });
  await prisma.agent.deleteMany({ where: { userId } });
  await prisma.cookieBundle.deleteMany({ where: { userId } });
  await prisma.browserPassword.deleteMany({ where: { userId } });
  await prisma.steelSessionAuth.deleteMany({ where: { userId } });
  await prisma.mintedAccount.deleteMany({ where: { userId } });
  await prisma.passkeyCredential.deleteMany({ where: { userId } });
  await prisma.browserContext.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { userId } });
}

async function request(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : await response.text();
  return { status: response.status, data };
}

test('provider classifier extracts normalized credential refs and aggregates by priority', async () => {
  const refs = extractCredentialRefs([
    {
      metadata: {
        credential_ref: [
          { kind: 'browserPassword', id: 'pw-1' },
          { kind: 'cookie', id: 'cookie-1' },
          { kind: 'webauthn', id: 'pk-1' },
          { kind: 'unknown', id: 'skip-me' },
        ],
      },
    },
    { metadata: { credentialRef: { kind: 'steel_auth', id: 'steel-1' } } },
    { metadata: null },
  ]);

  assert(refs.length === 4, `expected 4 refs, got ${refs.length}`);
  assert(
    refs.some((ref) => ref.kind === 'password' && ref.id === 'pw-1'),
    'password ref'
  );
  assert(
    refs.some((ref) => ref.kind === 'cookie_bundle'),
    'cookie bundle ref'
  );
  assert(
    refs.some((ref) => ref.kind === 'steel_session'),
    'steel ref'
  );
  assert(
    refs.some((ref) => ref.kind === 'passkey' && ref.id === 'pk-1'),
    'passkey ref (webauthn alias)'
  );

  const aggregate = aggregateDecision(
    [
      {
        credentialRef: refs[0],
        outcome: 'rate_limited',
        reason: '429',
        rawError: 'too many requests',
        failureReason: 'rate_limited',
      },
      {
        credentialRef: refs[1],
        outcome: 'auth_failed',
        reason: 'invalid',
        rawError: 'invalid password',
        failureReason: 'auth_exhausted',
      },
    ],
    'mixed'
  );
  assert(aggregate.outcome === 'auth_failed', 'auth_failed should win priority');
  assert(aggregate.failureReason === 'auth_exhausted', 'expected selected failure reason');
});

test('provider classifier parses mock LLM outcomes and fills missing credentials as unused', async () => {
  const refs = [
    { kind: 'password' as const, id: 'pw-1' },
    { kind: 'cookie_bundle' as const, id: 'cookie-1' },
  ];
  const result = await withEnv(
    {
      CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
      CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: JSON.stringify({
        reason: 'per credential classification',
        credentialOutcomes: [
          {
            kind: 'browserPassword',
            id: 'pw-1',
            outcome: 'rate_limited',
            reason: 'provider throttled',
          },
        ],
      }),
    },
    () =>
      classifyCredentialOutcomesBestEffort(
        {
          id: 'classifier-agent',
          goal: 'Sign in',
          status: 'FAILED',
          statusMessage: 'Too many requests, retry later',
        },
        [{ role: 'TOOL', text: 'HTTP 429 from login page', metadata: null }],
        refs
      )
  );

  assert(result.reason === 'per credential classification', 'expected classifier reason');
  assert(result.decisions.length === 2, 'expected one decision per credential');
  const passwordDecision = result.decisions.find(
    (decision) => decision.credentialRef.id === 'pw-1'
  );
  const cookieDecision = result.decisions.find(
    (decision) => decision.credentialRef.id === 'cookie-1'
  );
  assert(passwordDecision?.outcome === 'rate_limited', 'expected parsed password outcome');
  assert(passwordDecision.failureReason === 'rate_limited', 'expected mapped failure reason');
  assert(cookieDecision?.outcome === 'unused', 'expected missing credential to be unused');
});

test('provider classifier falls back when mock LLM response is invalid', async () => {
  const result = await withEnv(
    {
      CREDENTIAL_PROPAGATION_DISABLE_LLM: undefined,
      CREDENTIAL_PROPAGATION_MOCK_LLM_RESPONSE: 'not json',
    },
    () =>
      classifyCredentialOutcomesBestEffort(
        {
          id: 'classifier-invalid',
          goal: 'Sign in',
          status: 'FAILED',
          statusMessage: 'Cloudflare access denied',
        },
        [{ role: 'TOOL', text: 'anti-bot page appeared', metadata: null }],
        [{ kind: 'steel_session', id: 'steel-1' }]
      )
  );

  assert(result.reason === 'classifier_unavailable', 'expected unavailable fallback');
  assert(result.decisions[0].outcome === 'task_level', 'expected non-disabling fallback');
  assert(result.decisions[0].failureReason === null, 'expected no failure reason on fallback');
});

test('domain classifier deterministic fallbacks classify common browser failures', async () => {
  const agent = {
    id: 'domain-classifier',
    goal: 'Sign in',
    status: 'FAILED' as const,
    statusMessage: '',
  };
  const cases = [
    ['captcha', 'hcaptcha challenge', 'captcha'],
    ['antibot', 'Cloudflare access denied', 'antibot'],
    ['rate_limited', 'HTTP 429 too many requests', 'rate_limited'],
    ['account_locked', 'account locked by site', 'account_locked'],
    ['auth_failed', 'invalid password', 'auth_failed'],
    ['task_level', 'navigation exhausted before checkout', 'task_level'],
  ] as const;

  for (const [label, text, outcome] of cases) {
    const decision = domainHeuristicDecision(agent, [{ text }]);
    assert(decision.outcome === outcome, `${label} expected ${outcome}, got ${decision.outcome}`);
  }

  const completed = domainHeuristicDecision(
    { ...agent, status: 'COMPLETED' },
    [{ text: 'saved credential was rejected by the site' }],
    [{ kind: 'password', id: 'pw-1' }]
  );
  assert(completed.outcome === 'auth_failed', 'completed auth failure should be preserved');

  const unavailable = classifierUnavailableDecision(agent, [{ text: 'raw failure' }]);
  assert(unavailable.reason === 'classifier_unavailable', 'expected unavailable reason');

  const disabled = await withEnv({ CREDENTIAL_PROPAGATION_DISABLE_LLM: '1' }, () =>
    classifyDomainFailureBestEffort(agent, [{ role: 'TOOL', text: 'recaptcha challenge' }])
  );
  assert(disabled.outcome === 'captcha', 'disabled LLM should use heuristic decision');
});

test('domain repo loads run inputs and applies idempotent credential decisions', async () => {
  const userId = await createUser();
  try {
    const agent = await prisma.agent.create({
      data: {
        userId,
        goal: 'Use saved credentials',
        status: 'FAILED',
        statusMessage: 'invalid password',
      },
    });
    await prisma.message.create({
      data: {
        agentId: agent.id,
        role: 'TOOL',
        text: 'Authentication failed',
        metadata: { credential_ref: { kind: 'password', id: 'placeholder' } },
      },
    });
    const password = await prisma.browserPassword.create({
      data: {
        userId,
        origin: 'https://example.com',
        username: `user-${randomUUID()}@example.com`,
        encryptedPassword: 'encrypted',
        browserSource: 'chrome',
      },
    });

    const loadedAgent = await loadAgentForPropagation(agent.id);
    const loadedMessages = await loadMessagesForPropagation(agent.id);
    assert(loadedAgent?.id === agent.id, 'expected loaded agent');
    assert(loadedMessages.length === 1, 'expected loaded message');

    const firstMarker = await prisma.$transaction((tx) =>
      tryCreatePropagationMarker(tx, agent.id, { kind: 'password', id: password.id })
    );
    const secondMarker = await prisma.$transaction((tx) =>
      tryCreatePropagationMarker(tx, agent.id, { kind: 'password', id: password.id })
    );
    assert(firstMarker === true, 'expected first marker insert');
    assert(secondMarker === false, 'expected duplicate marker to be ignored');
    await prisma.agentRunCredentialPropagation.deleteMany({
      where: { agentId: `${agent.id}:password:${password.id}` },
    });

    const markerAgentId = `${userId}:${randomUUID()}`;
    const applied = await propagateCredentialInTransaction(
      markerAgentId,
      { kind: 'password', id: password.id },
      {
        outcome: 'auth_failed',
        reason: 'auth_exhausted',
        rawError: 'invalid password',
        failureReason: 'auth_exhausted',
      }
    );
    const duplicate = await propagateCredentialInTransaction(
      markerAgentId,
      { kind: 'password', id: password.id },
      {
        outcome: 'success',
        reason: 'agent_completed',
        rawError: null,
        failureReason: null,
      }
    );
    const updated = await prisma.browserPassword.findUniqueOrThrow({ where: { id: password.id } });
    assert(applied === true, 'expected first propagation to apply');
    assert(duplicate === false, 'expected duplicate propagation to skip');
    assert(updated.disabledAt !== null, 'expected password to be disabled');
    assert(updated.disabledReason?.includes('invalid password') === true, 'expected raw reason');
  } finally {
    await cleanup(userId);
  }
});

test('domain repo applies success and non-auth decisions across credential stores', async () => {
  const userId = await createUser();
  try {
    const cookieBundle = await prisma.cookieBundle.create({
      data: {
        userId,
        authRealm: 'example.com',
        browserSource: 'chrome',
        browserProfile: `profile-${randomUUID()}`,
        disabledAt: new Date(),
        disabledReason: 'old failure',
      },
    });
    const steel = await prisma.steelSessionAuth.create({
      data: { userId, contextId: `ctx-${randomUUID()}`, authRealm: 'example.com' },
    });
    const minted = await prisma.mintedAccount.create({
      data: { userId, authRealm: `minted-${randomUUID()}.com`, accountLabel: 'Test account' },
    });

    await propagateCredentialInTransaction(
      `${userId}:cookie:${randomUUID()}`,
      { kind: 'cookie_bundle', id: cookieBundle.id },
      { outcome: 'success', reason: 'agent_completed', rawError: null, failureReason: null }
    );
    await propagateCredentialInTransaction(
      `${userId}:steel:${randomUUID()}`,
      { kind: 'steel_session', id: steel.id },
      {
        outcome: 'captcha',
        reason: 'captcha_blocked',
        rawError: 'captcha challenge',
        failureReason: 'captcha_blocked',
      }
    );

    await propagateCredentialInTransaction(
      `${userId}:minted:${randomUUID()}`,
      { kind: 'minted', id: minted.id },
      {
        outcome: 'rate_limited',
        reason: 'rate_limited',
        rawError: 'too many requests',
        failureReason: 'rate_limited',
      }
    );

    const cookie = await prisma.cookieBundle.findUniqueOrThrow({ where: { id: cookieBundle.id } });
    const steelAuth = await prisma.steelSessionAuth.findUniqueOrThrow({ where: { id: steel.id } });
    const mintedAccount = await prisma.mintedAccount.findUniqueOrThrow({
      where: { id: minted.id },
    });
    assert(cookie.disabledAt === null, 'success should clear cookie disabledAt');
    assert(cookie.disabledReason === null, 'success should clear cookie disabledReason');
    assert(steelAuth.disabledAt === null, 'captcha should not set disabledAt');
    assert(steelAuth.disabledReason?.includes('captcha') === true, 'captcha reason expected');
    assert(mintedAccount.disabledReason?.includes('too many requests') === true, 'minted reason');
  } finally {
    await cleanup(userId);
  }
});

test('credential propagation route enforces auth, validates input, and handles missing agents', async () => {
  const unauthenticated = await request(`${BASE_URL}/api/credential-propagation/browser-run`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert(unauthenticated.status === 401, 'expected auth boundary');

  const invalid = await request(`${BASE_URL}/api/credential-propagation/browser-run`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({ agentId: '', taskId: '', status: '', success: false, message: '' }),
  });
  assert(invalid.status === 400, 'expected validation failure');

  const missing = await request(`${BASE_URL}/api/credential-propagation/browser-run`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: JSON.stringify({
      agentId: randomUUID(),
      taskId: 'browser-task',
      status: 'failed',
      success: false,
      message: 'failed before credentials',
    }),
  });
  assert(missing.status === 404, 'expected missing agent');
});

test('credential propagation route returns no-credential decision for existing agent', async () => {
  const userId = await createUser();
  try {
    const agent = await prisma.agent.create({
      data: { userId, goal: 'Browse without credentials', status: 'ACTIVE' },
    });
    const response = await request(`${BASE_URL}/api/credential-propagation/browser-run`, {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      body: JSON.stringify({
        agentId: agent.id,
        taskId: 'browser-task-no-creds',
        status: 'failed',
        success: false,
        message: 'navigation failed before credential use',
      }),
    });

    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = response.data as { refs?: unknown; applied?: unknown; outcome?: unknown };
    assert(body.refs === 0, 'expected zero refs');
    assert(body.applied === 0, 'expected zero applied credentials');
    assert(body.outcome === 'task_level', 'expected task-level outcome');
  } finally {
    await cleanup(userId);
  }
});

test('domain repo disables and re-enables a passkey credential', async () => {
  const userId = await createUser();
  try {
    const passkey = await prisma.passkeyCredential.create({
      data: {
        userId,
        authRealm: 'amazon.com',
        rpId: 'amazon.com',
        credentialId: `cred-${randomUUID()}`,
        encryptedPrivateKey: 'enc',
        userHandle: 'uh',
        signCount: 3,
      },
    });

    await propagateCredentialInTransaction(
      `${userId}:passkey-fail:${randomUUID()}`,
      { kind: 'passkey', id: passkey.id },
      {
        outcome: 'auth_failed',
        reason: 'auth_exhausted',
        rawError: 'passkey rejected by relying party',
        failureReason: 'auth_exhausted',
      }
    );
    let row = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id: passkey.id } });
    assert(row.disabledAt !== null, 'expected passkey disabled after auth_failed');
    assert(
      row.disabledReason?.includes('passkey rejected') === true,
      'expected raw reason recorded'
    );

    await propagateCredentialInTransaction(
      `${userId}:passkey-ok:${randomUUID()}`,
      { kind: 'passkey', id: passkey.id },
      { outcome: 'success', reason: 'agent_completed', rawError: null, failureReason: null }
    );
    row = await prisma.passkeyCredential.findUniqueOrThrow({ where: { id: passkey.id } });
    assert(row.disabledAt === null, 'expected success to clear passkey disabledAt');
    assert(row.disabledReason === null, 'expected success to clear passkey disabledReason');
  } finally {
    await cleanup(userId);
  }
});

async function main() {
  const results: Array<{ name: string; passed: boolean; error?: string; duration: number }> = [];
  for (const { name, fn } of [...tests, ...retryCases, ...mintedCases]) {
    const start = Date.now();
    try {
      await fn();
      results.push({ name, passed: true, duration: Date.now() - start });
    } catch (error) {
      results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      });
    }
  }

  console.log(`Credential Propagation Black-box Tests (${results.length} cases, runId=${RUN_ID})`);
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    console.log(
      `  ${status} ${result.name}${result.passed ? '' : ` - ${result.error}`} (${result.duration}ms)`
    );
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
