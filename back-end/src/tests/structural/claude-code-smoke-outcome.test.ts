import assert from 'assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { verifyStackSandboxes } from '../../../scripts/verify-stack-sandboxes';

import {
  ClaudeSmokeUserActionSkip,
  SANDBOX_PROOF,
  SMOKE_SKIP_BANNER,
  resultLine,
  runTest,
  summarizeResults,
} from '../blackbox/claude-code-smoke-outcome.support';

// Cements the Claude Code E2B smoke outcome contract (the former /deploy skill Step 6c). A credential
// or billing block only the user can fix used to print "[skip]" and return, so the
// smoke read "PASS  smoke -- Claude Code answers 2+2 (real E2B sandbox)" and the
// e2b-smoke gate passed without a sandbox. Such a block is now a loud SKIP with its
// evidence and a non-zero exit; every other no-sandbox path stays FAIL.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const blackbox = fs.readFileSync(
  path.join(repoRoot, 'back-end/src/tests/blackbox/claude-code.blackbox.ts'),
  'utf8'
);
const gate = fs.readFileSync(path.join(repoRoot, 'scripts/run-deploy-semantic-stack.sh'), 'utf8');

async function userActionBlockIsSkipNeverPass(): Promise<void> {
  const skip = await runTest('fixture smoke', () =>
    Promise.reject(
      new ClaudeSmokeUserActionSkip('credential', 'SDK 401\n  Invalid authentication credentials')
    )
  );
  assert.strictEqual(skip.passed, false, 'a user-action block must never be a PASS');
  assert.deepStrictEqual(skip.skipped, {
    kind: 'credential',
    evidence: 'SDK 401 Invalid authentication credentials',
  });
  assert.strictEqual(
    resultLine(skip),
    `  SKIP  fixture smoke -- USER ACTION REQUIRED (credential): SDK 401 Invalid authentication credentials (${skip.duration}ms)`
  );

  const failure = await runTest('fixture no sandbox', () =>
    Promise.reject(new Error('Timed out after 240s waiting for Claude Code smoke output'))
  );
  assert.strictEqual(failure.skipped, undefined, 'every other no-sandbox error stays FAIL');
  assert.ok(resultLine(failure).startsWith('  FAIL  fixture no sandbox -- Timed out'));

  const pass = await runTest('fixture pass', () => Promise.resolve());
  assert.strictEqual(resultLine(pass), `  PASS  fixture pass (${pass.duration}ms)`);

  assert.deepStrictEqual(summarizeResults([pass, failure, skip]), {
    passed: 1,
    failed: 1,
    skipped: 1,
    exitCode: 1,
  });
  assert.deepStrictEqual(summarizeResults([pass, skip]), {
    passed: 1,
    failed: 0,
    skipped: 1,
    exitCode: 1,
  });
  assert.deepStrictEqual(summarizeResults([pass]), {
    passed: 1,
    failed: 0,
    skipped: 0,
    exitCode: 0,
  });
}

function blackboxUsesTheContract(): void {
  assert.ok(!blackbox.includes('[skip]'), 'no smoke path may print "[skip]" and return a PASS');
  for (const kind of ["'credential'", "'billing'"]) {
    assert.ok(
      blackbox.includes(`throw new ClaudeSmokeUserActionSkip(\n        ${kind}`) ||
        blackbox.includes(`throw new ClaudeSmokeUserActionSkip(${kind}`),
      `the smoke must raise a ${kind} user-action SKIP`
    );
  }
  for (const needle of [
    "from './claude-code-smoke-outcome.support'",
    'summarizeResults(allResults)',
    'SMOKE_SKIP_BANNER',
    'SANDBOX_PROOF',
    'process.exit(summary.exitCode)',
  ]) {
    assert.ok(blackbox.includes(needle), `claude-code.blackbox.ts must use ${needle}`);
  }
  assert.ok(
    !/^interface TestResult\b/m.test(blackbox),
    'one TestResult definition: the support module'
  );
  assert.ok(!/^async function runTest\b/m.test(blackbox), 'one runTest: the support module');
  for (const line of [SANDBOX_PROOF, 'USER ACTION REQUIRED', SMOKE_SKIP_BANNER]) {
    assert.ok(gate.includes(line), `run-deploy-semantic-stack.sh must classify "${line}"`);
  }
}

async function main(): Promise<void> {
  await userActionBlockIsSkipNeverPass();
  blackboxUsesTheContract();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'e2b-completion-'));
  const keys = [
    'BLACKBOX_TEST_ARTIFACT_DIR',
    'BLACKBOX_TEST_DOMAIN',
    'BLACKBOX_SMOKE',
    'BLACKBOX_TEST_RUN_ID',
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    process.env.BLACKBOX_TEST_ARTIFACT_DIR = directory;
    process.env.BLACKBOX_TEST_DOMAIN = 'claude-code';
    process.env.BLACKBOX_SMOKE = '1';
    process.env.BLACKBOX_TEST_RUN_ID = 'fixture';
    const results = [
      { name: 'actual failure', passed: false, error: 'original error', duration: 5 },
    ];
    summarizeResults(results);
    const file = path.join(directory, `claude-code-completion-${process.pid}.json`);
    const completion = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(completion.results, results);
    assert.strictEqual(completion.runId, 'fixture');
    assert.deepStrictEqual(completion.summary, { passed: 0, failed: 1, skipped: 0, exitCode: 1 });
    assert.throws(() => summarizeResults(results), /EEXIST/);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    fs.rmSync(directory, { recursive: true });
  }
  assert.deepStrictEqual(
    await verifyStackSandboxes('fixture', async () => ({ items: [], nextCursor: null })),
    { roseStack: 'fixture', verified: true, remaining: [] }
  );
  assert.deepStrictEqual(
    await verifyStackSandboxes('fixture', async () => ({
      items: [
        {
          sandboxId: 'owned',
          metadata: { roseStack: 'fixture' },
          state: 'running',
          startedAt: new Date(0),
        },
      ],
      nextCursor: null,
    })),
    { roseStack: 'fixture', verified: false, remaining: ['owned'] }
  );
  await assert.rejects(
    () =>
      verifyStackSandboxes('fixture', async () => {
        throw new Error('provider unavailable');
      }),
    /provider unavailable/
  );
  let pages = 0;
  const incomplete = await verifyStackSandboxes('fixture', async () => {
    pages += 1;
    return { items: [], nextCursor: 'unseen-tail' };
  });
  assert.strictEqual(incomplete.verified, false);
  assert.strictEqual(pages, 10);
  console.log('PASS  claude-code smoke outcome: user-action SKIP is never a PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
