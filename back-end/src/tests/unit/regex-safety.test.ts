#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { checkPatternSafety } from '../../domains/data/regexSafety';

function run(): void {
  assert.equal(checkPatternSafety('(.*a){20}$', '').ok, false);
  assert.equal(checkPatternSafety('meeting.*tomorrow', '').ok, true);
  assert.equal(
    checkPatternSafety('Multiline incident START.*incident END', 's', 0).ok,
    true,
    'a provably linear single-wildcard pattern must not depend on analyzer scheduling'
  );
  for (const pattern of [
    '\\$[0-9,]+(\\.[0-9]{2})?',
    '(invoice|receipt|order)\\s+#?[0-9]+',
    '[\\w.]+@[\\w.]+',
    'v[0-9]+\\.[0-9]+\\.[0-9]+',
    '\\bphase-[0-9]+\\b',
    '[A-Z]{2,4}-[0-9]{2,5}',
  ]) {
    assert.equal(
      checkPatternSafety(pattern, '', 0).ok,
      true,
      `a syntactically proven degree-at-most-two pattern must not depend on analyzer scheduling: ${pattern}`
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

  process.stdout.write('PASS regex safety rejects dangerous and unclassified patterns\n');
}

run();
