#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { checkSync } from 'recheck';

import { checkPatternSafety, translateWordBoundaries } from '../../domains/data/regexSafety';

function run(): void {
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
  assert.equal(checkPatternSafety('(.*a){20}$', '').ok, false);
  assert.equal(checkPatternSafety('meeting.*tomorrow', '').ok, true);
  assert.equal(
    checkPatternSafety('Multiline incident START.*incident END', 's', 0).ok,
    true,
    'a provably linear single-wildcard pattern must not depend on analyzer scheduling'
  );
  for (const pattern of ['\\$[0-9,]+(\\.[0-9]{2})?', '[\\w.]+@[\\w.]+', '\\bphase-[0-9]+\\b']) {
    assert.equal(
      checkPatternSafety(pattern, '', 0).ok,
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
      checkPatternSafety(pattern, '', 0).ok,
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
      checkPatternSafety(pattern, '').ok,
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
      checkPatternSafety(pattern, '', 0).ok,
      false,
      `an ambiguous repetition chain must remain analyzer-owned and fail closed: ${pattern}`
    );
  }

  // An invalid runtime value makes recheck throw synchronously, exercising the
  // same fail-closed branch used when its bounded analysis times out.
  const analyzerFailure = checkPatternSafety('ordinary text', null as unknown as string);
  assert.equal(analyzerFailure.ok, false, 'analyzer failures must reject the unclassified pattern');
  assert.match(analyzerFailure.reason ?? '', /safety analysis did not complete/);

  const analyzerTimeout = checkPatternSafety('(.*a){20}$', '', 0);
  assert.equal(analyzerTimeout.ok, false, 'unknown timeout diagnostics must fail closed');
  assert.match(analyzerTimeout.reason ?? '', /safety analysis did not complete/);

  const injectedAnalyzerFailure = checkPatternSafety('safe-looking-pattern', '', () => {
    throw new Error('simulated analyzer timeout');
  });
  assert.deepEqual(injectedAnalyzerFailure, {
    ok: false,
    reason:
      'Pattern safety analysis did not complete. Use a simpler expression without nested quantifiers or stacked wildcards.',
  });

  let analyzerAttempts = 0;
  const analyzerTimeouts: number[] = [];
  const recoveredAfterLoadTimeout = checkPatternSafety('(invoice|receipt|order)\\s+#?[0-9]+', '', ((
    _source: string,
    _flags: string,
    options: { timeout: number }
  ) => {
    analyzerAttempts += 1;
    analyzerTimeouts.push(options.timeout);
    if (analyzerAttempts === 1) throw new Error('simulated load-induced analyzer timeout');
    return { status: 'safe' };
  }) as typeof checkSync);
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

  process.stdout.write('PASS regex safety rejects dangerous and unclassified patterns\n');
}

run();
