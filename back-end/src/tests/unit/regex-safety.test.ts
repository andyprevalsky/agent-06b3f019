#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { check } from 'recheck';

import { checkPatternSafety, translateWordBoundaries } from '../../domains/data/regexSafety';

async function testFiniteLiteralAlternations(): Promise<void> {
  for (const flags of ['', 'i', 'm', 's', 'ims']) {
    for (const pattern of [
      'Project Sync|Lease',
      'alpha|beta|gamma',
      'a|aa|aaa',
      'é|日本語|😀',
      String.raw`a\|b|c`,
      String.raw`a\\b|c`,
      String.raw`a\.b|c\+d`,
    ]) {
      assert.equal(
        (await checkPatternSafety(pattern, flags, 0)).ok,
        true,
        `finite literal alternation must not depend on analyzer scheduling: ${pattern} /${flags}`
      );
    }
  }
  for (const pattern of [
    'a|b+',
    'a+|b',
    'a|b+|c',
    'a|(b+)+',
    '(a+)+|b',
    'a|.*',
    '.*|a',
    'a|[b]',
    'a|(b)',
    'a|^b',
    'a|b$',
    'a|(?=b)',
    String.raw`a|\1`,
    String.raw`a|\w`,
    String.raw`a|\x61`,
    String.raw`a|\u0061`,
    String.raw`a|\k<name>`,
    'a|b\\',
    '|a',
    'a|',
    'a||b',
    String.raw`a\|b|c+`,
    String.raw`a\q|b`,
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, '', 0)).ok,
      false,
      `an unproved alternative must remain analyzer-owned: ${pattern}`
    );
  }
  assert.equal(
    (await checkPatternSafety(String.raw`a\|b`, '', 0)).ok,
    true,
    'escaped pipe remains a literal under the existing linear proof'
  );
  assert.equal(
    (await checkPatternSafety('a|b', 'u', 0)).ok,
    false,
    'unproved flags remain analyzer-owned'
  );
  assert.equal(
    (await checkPatternSafety('a'.repeat(1000) + '|b', '', 0)).ok,
    false,
    'the existing length cap precedes local proof'
  );
  let calls = 0;
  assert.equal(
    (
      await checkPatternSafety('a|b', '', () => {
        calls += 1;
        return Promise.resolve({ status: 'unknown' }) as ReturnType<typeof check>;
      })
    ).ok,
    false,
    'explicit analyzer seam still overrides every local proof'
  );
  assert.equal(calls, 3, 'explicit analyzer seam retains existing retry count');
  process.stdout.write('PASS finite literal alternation safety proof\n');
}

/**
 * Chat-router greps rejected as "Pattern safety analysis did not complete"
 * (production 2026-11-10 and 2026-11-12, after `(?i)` folding): recheck rates
 * them degree 2 but needs over a second, past the gate's deadline.
 */
async function testWildcardLiteralAlternations(): Promise<void> {
  for (const [pattern, flags] of [
    ['azure.*credit|credit.*azure|azure.*spend|spend.*azure|azure.*justif|justif.*azure', 'is'],
    ['(oauth|verification|security review|google.*submit|rose.*oauth|oauth.*rose)', 'i'],
    [
      '(oauth|consent|google cloud|api.*submit|submit.*api|security.*review|verification.*status)',
      'i',
    ],
    ['(?:move.*out|moving)', ''],
    [String.raw`a\.b.*c\|d|e`, 'm'],
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, flags, 0)).ok,
      true,
      `a union of literal and single-wildcard branches must not depend on analyzer scheduling: ${pattern} /${flags}`
    );
  }
  for (const pattern of [
    'a.*b.*c|d',
    'a.*.*b|c',
    '.*a|b',
    'a.*|b',
    'a.+b|c',
    'a.*?b|c',
    'a.b|c',
    'a.*b|c+',
    'a.*b|(c+)+',
    '(a.*b|c)+',
    '(a.*b|c)*',
    '(?:a.*b|c){2}',
    '(a|b.*c)d',
    'x(a|b.*c)',
    '(a|b)|(c.*d)',
    '(a.*b|.*c)',
    '(?=a.*b|c)',
    '(?<n>a.*b|c)',
    '(a.*b|c',
    'a.*b|',
    '|a.*b',
    '^a.*b|c',
    'a.*b|c$',
    '[ab].*c|d',
    String.raw`a.*\w|b`,
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, '', 0)).ok,
      false,
      `a union outside the literal/single-wildcard grammar must remain analyzer-owned: ${pattern}`
    );
  }
  assert.equal(
    (await checkPatternSafety('a.*b|c.*d', 'u', 0)).ok,
    false,
    'unproved flags remain analyzer-owned'
  );
  // Through the real analyzer, unions with a degree > 2 or exponential branch still fail closed.
  for (const pattern of ['.*a.*a.*X|azure.*credit', '(a|aa)+X|credit.*azure', '(a+)+$|b.*c']) {
    assert.equal(
      (await checkPatternSafety(pattern, '')).ok,
      false,
      `a union with a catastrophic branch must stay rejected: ${pattern}`
    );
  }
  process.stdout.write('PASS literal/single-wildcard alternation safety proof\n');
}

async function run(): Promise<void> {
  await testFiniteLiteralAlternations();
  await testWildcardLiteralAlternations();
  for (const pattern of [
    String.raw`\\bpassport\\b`,
    String.raw`[\b]`,
    String.raw`[\B]`,
    String.raw`[\\b]`,
    String.raw`\[b\]`,
  ]) {
    assert.equal(
      translateWordBoundaries(pattern),
      pattern,
      `literal escape/class changed: ${pattern}`
    );
  }
  const boundaryCases = [
    '',
    'passport',
    'Josépassport',
    'αpassport',
    'passporté',
    'passport_',
    'xpassport',
    '9passport',
    'PASSPORT',
    'passport passport',
    '\\passport',
    '\bpassport',
  ];
  for (const pattern of [
    String.raw`\bpassport\b`,
    String.raw`\Bpassport`,
    String.raw`passport\B`,
    String.raw`\b`,
    String.raw`\B`,
    String.raw`^\B$`,
    String.raw`\b(passport)\b\1`,
    String.raw`\b(passport)\b \1\b`,
    String.raw`\\\bpassport`,
  ]) {
    for (const flags of ['', 'i']) {
      for (const text of boundaryCases) {
        const actual = new RegExp(translateWordBoundaries(pattern), flags).exec(text);
        const expected = new RegExp(pattern, flags).exec(text);
        assert.deepEqual(
          actual,
          expected,
          `word-boundary conversion changed ${pattern} /${flags} on ${JSON.stringify(text)}`
        );
      }
    }
  }
  assert.equal((await checkPatternSafety('(.*a){20}$', '')).ok, false);
  assert.equal((await checkPatternSafety('meeting.*tomorrow', '')).ok, true);
  assert.equal(
    (await checkPatternSafety('Multiline incident START.*incident END', 's', 0)).ok,
    true,
    'a provably linear single-wildcard pattern must not depend on analyzer scheduling'
  );
  for (const pattern of ['\\$[0-9,]+(\\.[0-9]{2})?', '[\\w.]+@[\\w.]+', '\\bphase-[0-9]+\\b']) {
    assert.equal(
      (await checkPatternSafety(pattern, '', 0)).ok,
      true,
      `a syntactically proven degree-at-most-two pattern must not depend on analyzer scheduling: ${pattern}`
    );
  }

  // Postgres resolves a bracket range like `0-9` against the active collation,
  // and no regex sink pins `COLLATE "C"`, so the local proof cannot know a
  // range's real membership. It must fail closed rather than separate two
  // repetition frontiers on an assumed ASCII ordering.
  for (const pattern of [
    '(invoice|receipt|order)\\s+#?[0-9]+',
    'v[0-9]+\\.[0-9]+\\.[0-9]+',
    '[A-Z]{2,4}-[0-9]{2,5}',
    '[A-Z]{1,5}[0-9]{1,5}X',
    '[A-Z]+[0-9]+[A-Z]+[0-9]+X',
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, '', 0)).ok,
      false,
      `a collation-dependent range must never be locally proven disjoint: ${pattern}`
    );
  }
  // Failing closed hands the pattern to the analyzer, so realistic queries are
  // still accepted end to end — the fast path narrows, the capability does not.
  for (const pattern of [
    '(invoice|receipt|order)\\s+#?[0-9]+',
    'v[0-9]+\\.[0-9]+\\.[0-9]+',
    '[A-Z]{2,4}-[0-9]{2,5}',
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, '')).ok,
      true,
      `a realistic range-based query must stay usable via the analyzer: ${pattern}`
    );
  }
  for (const pattern of [
    '(a|aa){500}X',
    '(a|aa){1,500}X',
    'a+aa+a+X',
    '.*a.*a.*X',
    'a{1,500}a{1,500}a{1,500}X',
    '(a{1,500}a{1,500}a{1,500}X)',
    'a{0,500}a{0,500}a{0,500}X',
    '[a]{1,500}a[a]{1,500}a[a]{1,500}X',
    'a{0,1}'.repeat(30) + 'a'.repeat(30) + 'X',
    '[a]{0,500}b',
    '[a]{1,500}b',
    '[a]{0,500}b[a]{0,500}b[a]{0,500}X',
    '[a]{1,20}b[a]{1,20}b[a]{1,20}X',
    '[A-\\w]+x[A-\\w]+x[A-\\w]+X',
  ]) {
    assert.equal(
      (await checkPatternSafety(pattern, '', 0)).ok,
      false,
      `an ambiguous repetition chain must remain analyzer-owned and fail closed: ${pattern}`
    );
  }

  // An invalid runtime value makes recheck reject, exercising the same
  // fail-closed branch used when its bounded analysis times out.
  const analyzerFailure = await checkPatternSafety('ordinary text', null as unknown as string);
  assert.equal(analyzerFailure.ok, false, 'analyzer failures must reject the unclassified pattern');
  assert.match(analyzerFailure.reason ?? '', /safety analysis did not complete/);

  const analyzerTimeout = await checkPatternSafety('(.*a){20}$', '', 0);
  assert.equal(analyzerTimeout.ok, false, 'unknown timeout diagnostics must fail closed');
  assert.match(analyzerTimeout.reason ?? '', /safety analysis did not complete/);

  const injectedAnalyzerFailure = await checkPatternSafety('safe-looking-pattern', '', () => {
    throw new Error('simulated analyzer timeout');
  });
  assert.deepEqual(injectedAnalyzerFailure, {
    ok: false,
    reason:
      'Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards.',
  });

  let analyzerAttempts = 0;
  const analyzerTimeouts: number[] = [];
  const recoveredAfterLoadTimeout = await checkPatternSafety(
    '(invoice|receipt|order)\\s+#?[0-9]+',
    '',
    ((_source: string, _flags: string, options: { timeout: number }) => {
      analyzerAttempts += 1;
      analyzerTimeouts.push(options.timeout);
      if (analyzerAttempts === 1) throw new Error('simulated load-induced analyzer timeout');
      return Promise.resolve({ status: 'safe' });
    }) as unknown as typeof check
  );
  assert.equal(analyzerAttempts, 2, 'a single analyzer timeout must be retried once');
  assert.ok(
    analyzerTimeouts.every((timeout) => timeout <= 1000),
    'retries must share the original 1000ms analyzer budget'
  );
  assert.equal(
    recoveredAfterLoadTimeout.ok,
    true,
    'a realistic range query must stay usable after one analyzer timeout'
  );

  // The 1000 ms deadline is wall-clock: recheck never settles a call whose agent
  // died, and queued requests start its own timeout only when they run.
  const unclassifiedAfterDeadline = async (analyzer: typeof check, label: string) => {
    const startedAt = Date.now();
    let watchdog: NodeJS.Timeout | undefined;
    const verdict = await Promise.race([
      checkPatternSafety('safe-looking-pattern', '', analyzer),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error(`${label}: never settled`)), 3000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    const elapsed = Date.now() - startedAt;
    assert.equal(verdict.ok, false, `${label}: an unsettled analysis must fail closed`);
    assert.match(verdict.reason ?? '', /safety analysis did not complete/);
    assert.ok(elapsed < 1500, `${label}: settled after ${elapsed} ms, past the 1000 ms deadline`);
  };
  await unclassifiedAfterDeadline(
    (() => new Promise(() => undefined)) as unknown as typeof check,
    'dead analyzer agent'
  );
  const signals: AbortSignal[] = [];
  await unclassifiedAfterDeadline(
    ((_source: string, _flags: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      return new Promise(() => undefined);
    }) as unknown as typeof check,
    'queued analysis'
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    signals.length > 0 && signals.every((signal) => signal.aborted),
    'every analysis must be told to abort by its deadline, so the agent stops working on it'
  );

  process.stdout.write('PASS regex safety rejects dangerous and unclassified patterns\n');
}

void run();
