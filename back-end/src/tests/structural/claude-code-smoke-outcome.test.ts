import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ClaudeSmokeUserActionSkip,
  SANDBOX_PROOF,
  SMOKE_SKIP_BANNER,
  resultLine,
  runTest,
  summarizeResults,
} from '../blackbox/claude-code-smoke-outcome.support';

// Cements the Claude Code E2B smoke outcome contract (.claude/commands/DEPRECATED_deploy.md Step 6c). A credential
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
  console.log('PASS  claude-code smoke outcome: user-action SKIP is never a PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
