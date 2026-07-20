#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { checkPatternSafety } from '../../domains/data/regexSafety';

function run(): void {
  assert.equal(checkPatternSafety('(.*a){20}$', '').ok, false);
  assert.equal(checkPatternSafety('meeting.*tomorrow', '').ok, true);

  // An invalid runtime value makes recheck throw synchronously, exercising the
  // same fail-closed branch used when its bounded analysis times out.
  const analyzerFailure = checkPatternSafety('ordinary text', null as unknown as string);
  assert.equal(analyzerFailure.ok, false, 'analyzer failures must reject the unclassified pattern');
  assert.match(analyzerFailure.reason ?? '', /safety analysis could not complete/);

  const analyzerTimeout = checkPatternSafety('(.*a){20}$', '', 0);
  assert.equal(analyzerTimeout.ok, false, 'unknown timeout diagnostics must fail closed');
  assert.match(analyzerTimeout.reason ?? '', /safety analysis could not complete/);

  process.stdout.write('PASS regex safety rejects dangerous and unclassified patterns\n');
}

run();
