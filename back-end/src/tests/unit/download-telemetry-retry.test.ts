#!/usr/bin/env tsx

import assert from 'node:assert/strict';

import { isRetryableAmplitudeError } from '../../domains/download-telemetry/repo';

assert.equal(isRetryableAmplitudeError(new TypeError('network down')), true);
assert.equal(
  isRetryableAmplitudeError(new DOMException('request timed out', 'TimeoutError')),
  true
);
assert.equal(isRetryableAmplitudeError(new DOMException('cancelled', 'AbortError')), false);
assert.equal(isRetryableAmplitudeError(new Error('permanent failure')), false);

process.stdout.write('download telemetry retry classification tests passed\n');
