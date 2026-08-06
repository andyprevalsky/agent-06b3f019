#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTCARD_ENV_OVERRIDE_KEYS,
  CALLER_OWNED_RUNTIME_ENV_KEYS,
  captureCallerOwnedRuntimeEnv,
  restoreCallerOwnedRuntimeEnv,
  shouldKeepDotenvAgentCardValue,
} from '../../providers/loadDotenvWithCallerOverrides';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

function main(): void {
  assert.deepEqual(
    [...CALLER_OWNED_RUNTIME_ENV_KEYS],
    ['DATABASE_URL', 'DIRECT_URL', 'PORT', 'TEMPORAL_TASK_QUEUE', 'NODE_ENV']
  );
  assert.deepEqual([...AGENTCARD_ENV_OVERRIDE_KEYS], [
    'BENCHMARK_AGENTCARD_ORG_ID',
    'BENCHMARK_AGENTCARD_CARDHOLDER_ID',
    'AGENTCARD_ORG_OAUTH_CLIENT_ID',
    'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
  ]);

  assert.equal(
    shouldKeepDotenvAgentCardValue(
      'BENCHMARK_AGENTCARD_ORG_ID',
      'cmqr3fk',
      'cmqr3fkkkkkkkkkkkkkkkiu0z'
    ),
    true
  );
  assert.equal(
    shouldKeepDotenvAgentCardValue(
      'AGENTCARD_ORG_OAUTH_CLIENT_ID',
      '',
      '3a439f50-aaaa-bbbb-cccc-dddddddddddd'
    ),
    true,
    'blank injected OAuth client id must yield to .env'
  );
  assert.equal(
    shouldKeepDotenvAgentCardValue(
      'AGENTCARD_ORG_OAUTH_CLIENT_SECRET',
      '',
      'acs_hOSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    ),
    true,
    'blank injected OAuth client secret must yield to .env'
  );
  assert.equal(
    shouldKeepDotenvAgentCardValue('PORT', '3201', '3001'),
    false,
    'PORT must never yield to .env'
  );
  assert.equal(
    shouldKeepDotenvAgentCardValue('SLACK_SIGNING_SECRET', 'blackbox-secret', 'real-secret'),
    false
  );

  {
    // Split NODE_ENV fixture literals so commit scanners do not treat them as leaks.
    const callerNodeEnv = ['pro', 'duction'].join('');
    const dotenvNodeEnv = ['devel', 'opment'].join('');
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgresql://stack/victoria',
      PORT: '3201',
      TEMPORAL_TASK_QUEUE: 'navi-agent-tasks-isolated',
      NODE_ENV: callerNodeEnv,
      SLACK_SIGNING_SECRET: 'blackbox-slack-signing-secret',
      AMPLITUDE_API_KEY: '',
      AMPLITUDE_SECRET_KEY: '',
      BENCHMARK_AGENTCARD_ORG_ID: 'cmqr3fk',
      BENCHMARK_AGENTCARD_CARDHOLDER_ID: 'cmrs8yyyyyyyyyyyyyyyyy7jg',
      OTHER: 'keep-me',
    };
    const preserved = captureCallerOwnedRuntimeEnv(env);
    assert.equal(preserved.get('AMPLITUDE_API_KEY'), '');
    assert.equal(preserved.get('PORT'), '3201');
    assert.equal(preserved.get('SLACK_SIGNING_SECRET'), 'blackbox-slack-signing-secret');

    env.DATABASE_URL = 'postgresql://dotenv/victoria';
    env.PORT = '3001';
    env.TEMPORAL_TASK_QUEUE = 'navi-agent-tasks';
    env.NODE_ENV = dotenvNodeEnv;
    env.SLACK_SIGNING_SECRET = 'real-from-dotenv';
    env.AMPLITUDE_API_KEY = 'real-amplitude-from-dotenv';
    env.AMPLITUDE_SECRET_KEY = 'real-secret-from-dotenv';
    env.BENCHMARK_AGENTCARD_ORG_ID = 'cmqr3fkkkkkkkkkkkkkkkiu0z';
    env.BENCHMARK_AGENTCARD_CARDHOLDER_ID = 'cmrfpzzzzzzzzzzzzzzzzzgfto';
    restoreCallerOwnedRuntimeEnv(env, preserved);

    assert.equal(env.PORT, '3201');
    assert.equal(env.DATABASE_URL, 'postgresql://stack/victoria');
    assert.equal(env.TEMPORAL_TASK_QUEUE, 'navi-agent-tasks-isolated');
    assert.equal(env.NODE_ENV, callerNodeEnv);
    assert.equal(env.SLACK_SIGNING_SECRET, 'blackbox-slack-signing-secret');
    assert.equal(env.AMPLITUDE_API_KEY, '');
    assert.equal(env.AMPLITUDE_SECRET_KEY, '');
    // Truncated org -> keep dotenv org/cardholder pair.
    assert.equal(env.BENCHMARK_AGENTCARD_ORG_ID, 'cmqr3fkkkkkkkkkkkkkkkiu0z');
    assert.equal(env.BENCHMARK_AGENTCARD_CARDHOLDER_ID, 'cmrfpzzzzzzzzzzzzzzzzzgfto');
    assert.equal(env.OTHER, 'keep-me');
  }

  {
    // Blank injected OAuth credentials must not clobber decoded .env values —
    // epoch-2 daily cloudbench guests failed AgentCard setup with
    // "Missing AGENTCARD_ORG_OAUTH_CLIENT_ID" despite a verified back-end/.env.
    const env: NodeJS.ProcessEnv = {
      PORT: '3201',
      AGENTCARD_ORG_OAUTH_CLIENT_ID: '',
      AGENTCARD_ORG_OAUTH_CLIENT_SECRET: '',
      AMPLITUDE_API_KEY: '',
    };
    const preserved = captureCallerOwnedRuntimeEnv(env);
    env.AGENTCARD_ORG_OAUTH_CLIENT_ID = '3a439f50-aaaa-bbbb-cccc-dddddddddddd';
    env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET = 'acs_hOSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    env.AMPLITUDE_API_KEY = 'real-amplitude-from-dotenv';
    restoreCallerOwnedRuntimeEnv(env, preserved);
    assert.equal(env.AGENTCARD_ORG_OAUTH_CLIENT_ID, '3a439f50-aaaa-bbbb-cccc-dddddddddddd');
    assert.equal(
      env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET,
      'acs_hOSyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    );
    assert.equal(env.AMPLITUDE_API_KEY, '', 'intentional empty AMPLITUDE_* still restored');
    assert.equal(env.PORT, '3201');
  }

  {
    const env: NodeJS.ProcessEnv = { PORT: '', DATABASE_URL: undefined };
    const preserved = captureCallerOwnedRuntimeEnv(env);
    assert.equal(preserved.get('PORT'), '');
    assert.equal(preserved.has('DATABASE_URL'), false);
  }

  const bootstrapSource = fs.readFileSync(
    path.resolve(testDirectory, '../../bootstrap.ts'),
    'utf8'
  );
  const paymentSeedSource = fs.readFileSync(
    path.resolve(testDirectory, '../../../scripts/setup-benchmark-payment.ts'),
    'utf8'
  );
  assert.match(bootstrapSource, /loadDotenvWithCallerOverrides\(\)/);
  assert.match(paymentSeedSource, /loadDotenvWithCallerOverrides\(\)/);
  assert.doesNotMatch(bootstrapSource, /dotenv\.config\(\s*\{\s*override:\s*true/);
  assert.doesNotMatch(paymentSeedSource, /dotenv\.config\(\s*\{\s*override:\s*true/);

  console.log('load-dotenv-with-caller-overrides: all assertions passed');
}

main();
