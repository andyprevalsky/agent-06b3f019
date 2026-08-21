import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');
const healthSuite = path.join(backendDir, 'src/tests/blackbox/integration-health.blackbox.ts');

// Cements what the /deploy Step 4c credential-health gate must actually prove.
//
// The OpenRouter probe used to call /api/v1/auth/key only. That endpoint answers
// "is this key real", never "can it pay for a completion", so the gate reported
// PASS at $35.90 remaining while the agent pools were taking HTTP 402
// "Insufficient credits" on every call. OpenRouter is the waterfall backstop
// behind a rate-limited Claude compute token, so an exhausted balance leaves
// agents with no provider at all -- a benchmark slice scored 0/9 behind a green
// credential gate, and a deploy would have shipped into the same wall.
//
// A credential probe that cannot observe funding state is not a health check.
const source = fs.readFileSync(healthSuite, 'utf8');

const writeOut = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

function test(name: string, fn: () => void): void {
  try {
    fn();
    writeOut(`  \u2705 ${name}`);
  } catch (error) {
    writeOut(`  \u274c ${name}`);
    throw error;
  }
}

writeOut('credential-health coverage invariants:');

test('OpenRouter funding state is probed, not just auth', () => {
  assert.ok(
    source.includes('openrouter.ai/api/v1/credits'),
    'The OpenRouter probe must query /api/v1/credits. Checking /auth/key alone reports a ' +
      'healthy provider while every completion 402s for lack of funds.'
  );
});

test('an exhausted OpenRouter balance fails the gate', () => {
  assert.ok(
    /remaining\s*<=\s*0/.test(source),
    'A zero-or-negative OpenRouter balance must hard-fail credential health: with the ' +
      'waterfall backstop unfunded, a rate-limited compute token leaves agents no provider.'
  );
});

test('a low OpenRouter balance is surfaced before it hits zero', () => {
  assert.ok(
    source.includes('OPENROUTER_MIN_CREDITS_USD'),
    'A low-balance warning must exist and be tunable. Expensive pool models return 402 ' +
      'while the account still shows a positive balance, so zero is too late to warn.'
  );
  assert.ok(
    source.includes(
      "{ name: 'OpenRouter credit balance', fn: checkOpenRouterBalance, warnOnly: true }"
    ),
    'The low-balance probe must be registered in the checks array as warnOnly, so it is ' +
      'reported on every deploy without blocking on a merely-thin balance.'
  );
});

writeOut('\nAll credential-health coverage invariants hold.');
