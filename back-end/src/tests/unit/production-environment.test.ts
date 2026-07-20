import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertProductionEnvironment,
  REQUIRED_PRODUCTION_ENVIRONMENT_KEYS,
} from '../../providers/productionEnvironment';

const validProductionEnvironment: NodeJS.ProcessEnv = {
  RENDER: 'true',
  NODE_ENV: 'production',
  BACKEND_API_KEY: 'backend-api-key',
  DATABASE_URL: 'postgresql://runtime.example/rose',
  DIRECT_URL: 'postgresql://direct.example/rose',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUPABASE_JWT_SECRET: 'jwt-secret',
  TEMPORAL_ADDRESS: 'example.tmprl.cloud:7233',
  TEMPORAL_API_KEY: 'temporal-api-key',
  TEMPORAL_NAMESPACE: 'rose.example',
  TEMPORAL_TASK_QUEUE: 'navi-agent-tasks',
  STRIPE_SECRET_KEY: 'sk_live_example',
  STRIPE_SUBSCRIPTION_PRICE_ID: 'price_example123',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  ALLOWED_ORIGINS: 'https://www.roselabs.ai,https://roselabs.ai',
};

function without(environment: NodeJS.ProcessEnv, ...keys: readonly string[]): NodeJS.ProcessEnv {
  const copy = { ...environment };
  for (const key of keys) delete copy[key];
  return copy;
}

assert.doesNotThrow(() => assertProductionEnvironment(validProductionEnvironment));

assert.doesNotThrow(() =>
  assertProductionEnvironment({
    NODE_ENV: 'development',
  })
);

assert.throws(
  () =>
    assertProductionEnvironment(
      without(validProductionEnvironment, 'STRIPE_SUBSCRIPTION_PRICE_ID')
    ),
  /Missing required production environment variables: STRIPE_SUBSCRIPTION_PRICE_ID/
);

assert.throws(
  () => assertProductionEnvironment(without(validProductionEnvironment, 'NODE_ENV')),
  /Missing required production environment variables: NODE_ENV/
);

assert.throws(
  () =>
    assertProductionEnvironment({
      ...validProductionEnvironment,
      BACKEND_API_KEY: '   ',
      TEMPORAL_API_KEY: '',
    }),
  /Missing required production environment variables: BACKEND_API_KEY, TEMPORAL_API_KEY/
);

assert.throws(
  () =>
    assertProductionEnvironment({
      ...validProductionEnvironment,
      STRIPE_SUBSCRIPTION_PRICE_ID: 'https://example.com/subscribe',
    }),
  /Invalid production environment variables: STRIPE_SUBSCRIPTION_PRICE_ID/
);

assert.throws(
  () =>
    assertProductionEnvironment({
      ...validProductionEnvironment,
      STRIPE_SECRET_KEY: 'sk_live_',
      STRIPE_WEBHOOK_SECRET: 'webhook-secret',
    }),
  /Invalid production environment variables: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/
);

assert.throws(
  () =>
    assertProductionEnvironment({
      ...validProductionEnvironment,
      STRIPE_SUBSCRIPTION_PRICE_ID: ' price_example123 ',
    }),
  /Invalid production environment variables: STRIPE_SUBSCRIPTION_PRICE_ID/
);

assert.deepEqual(REQUIRED_PRODUCTION_ENVIRONMENT_KEYS, [
  'NODE_ENV',
  'BACKEND_API_KEY',
  'DATABASE_URL',
  'DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'TEMPORAL_ADDRESS',
  'TEMPORAL_API_KEY',
  'TEMPORAL_NAMESPACE',
  'TEMPORAL_TASK_QUEUE',
  'STRIPE_SECRET_KEY',
  'STRIPE_SUBSCRIPTION_PRICE_ID',
  'STRIPE_WEBHOOK_SECRET',
  'ALLOWED_ORIGINS',
]);

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.resolve(testDirectory, '../../server.ts'), 'utf8');
const bootstrapSource = fs.readFileSync(path.resolve(testDirectory, '../../bootstrap.ts'), 'utf8');
const billingServiceSource = fs.readFileSync(
  path.resolve(testDirectory, '../../domains/billing/service.ts'),
  'utf8'
);
const validationCallIndex = bootstrapSource.indexOf('assertProductionEnvironment(process.env)');
const serverImportIndex = bootstrapSource.indexOf("import('./server')");

assert.ok(validationCallIndex >= 0, 'backend startup must validate the production environment');
assert.ok(
  validationCallIndex < serverImportIndex,
  'production environment validation must run before server providers are imported'
);
assert.ok(
  !serverSource.includes('key_prefix') && !serverSource.includes('BACKEND_API_KEY.substring'),
  'server startup must not log any portion of BACKEND_API_KEY'
);
assert.ok(
  !billingServiceSource.includes('SUBSCRIBE_FALLBACK_URL'),
  'subscription checkout must not silently fall back to an unrelated public page'
);
assert.ok(
  billingServiceSource.includes("throw new Error('STRIPE_SUBSCRIPTION_PRICE_ID is required')"),
  'subscription checkout must surface a missing Stripe price when called outside startup'
);

const bootstrapPath = path.resolve(testDirectory, '../../bootstrap.ts');
const backendDirectory = path.resolve(testDirectory, '../../..');
const failedBoot = spawnSync('npx', ['tsx', bootstrapPath], {
  cwd: backendDirectory,
  encoding: 'utf8',
  env: {
    ...process.env,
    RENDER: 'true',
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: '',
    STRIPE_SUBSCRIPTION_PRICE_ID: '',
  },
  timeout: 15_000,
});
const failedBootOutput = `${failedBoot.stdout}${failedBoot.stderr}`;

assert.notEqual(failedBoot.status, 0, 'a production server missing Stripe config must not boot');
assert.match(failedBootOutput, /STRIPE_SECRET_KEY/);
assert.match(failedBootOutput, /STRIPE_SUBSCRIPTION_PRICE_ID/);
assert.doesNotMatch(failedBootOutput, /Server started/);

process.stdout.write('Production environment startup contracts passed\n');
