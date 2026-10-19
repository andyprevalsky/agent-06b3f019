/**
 * Production deploy scripts must IMPORT without third-party credentials.
 *
 * `providers/stripe.ts` built its default client with `new Stripe(KEY)` at
 * module scope, so importing it with no STRIPE_SECRET_KEY threw
 * `Neither apiKey nor config.authenticator provided` during module evaluation —
 * before any caller ran a line of its own logic.
 *
 * That turned a Stripe-usage concern into an import-graph concern. On
 * 2026-08-22 it took down the production deploy cutover: once
 * `agentRestartService` began importing `agentCleanup` -> `purchaseCleanup` ->
 * `stripe`, `migrate-open-agent-workflows.ts` died at import in the
 * deploy-agents workflow (which has DB + Temporal secrets but no Stripe key).
 * The queue pointer had already flipped, so the fleet was live but no
 * old-generation workflow was respawned.
 *
 * These scripts run in credential-scoped CI environments. Importing one must
 * never require a credential it does not use. Failing loudly at the first real
 * Stripe CALL is correct; failing at import is not.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

function resolveTsxBinary(): string {
  const candidates = [
    path.join(BACKEND_ROOT, 'node_modules', '.bin', 'tsx'),
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `tsx binary not found for deploy-script import-safety probe (tried: ${candidates.join(', ')})`
  );
}

/** Entry points the deploy pipeline imports in credential-scoped environments. */
const DEPLOY_SCRIPT_MODULES = [
  'src/domains/agents/agentRestartService.ts',
  'src/providers/workflowDeploymentMigration.ts',
  'src/providers/workflowDescendantCleanup.ts',
  'src/providers/staleWorkflowTools.ts',
  'src/providers/generationHandoffBroadcast.ts',
];

/** Credentials the cutover environment genuinely does not have. */
const ABSENT_CREDENTIALS = {
  STRIPE_SECRET_KEY: '',
  STRIPE_SECRET_KEY_LIVE: '',
};

function importsCleanly(moduleRelPath: string): { ok: boolean; detail: string } {
  try {
    const output = execFileSync(
      resolveTsxBinary(),
      [
        '-e',
        `import('./${moduleRelPath}')` +
          `.then(() => console.log('IMPORT_OK'))` +
          `.catch((error) => { console.log('IMPORT_FAILED:' + error.message); process.exit(3); })`,
      ],
      {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...ABSENT_CREDENTIALS,
          // Never touch a real database from a structural test.
          DATABASE_URL: 'postgresql://structural:structural@127.0.0.1:1/structural',
          DIRECT_URL: 'postgresql://structural:structural@127.0.0.1:1/structural',
        },
      }
    );
    return { ok: output.includes('IMPORT_OK'), detail: output.trim() };
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    return { ok: false, detail: `${stdout}${stderr}`.trim().slice(0, 400) };
  }
}

let failures = 0;
for (const moduleRelPath of DEPLOY_SCRIPT_MODULES) {
  const { ok, detail } = importsCleanly(moduleRelPath);
  if (ok) {
    console.log(`PASS ${moduleRelPath} imports without Stripe credentials`);
    continue;
  }
  failures += 1;
  console.error(
    `FAIL ${moduleRelPath} cannot be imported without Stripe credentials.\n` +
      `      A deploy script must not construct a third-party client at module scope.\n` +
      `      Make the client lazy so the failure lands at first use, not at import.\n` +
      `      Detail: ${detail}`
  );
}

assert.strictEqual(
  failures,
  0,
  `${failures} deploy script module(s) require credentials merely to be imported`
);
console.log('deploy script import-safety structural tests passed');
