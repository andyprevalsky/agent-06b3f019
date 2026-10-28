#!/usr/bin/env tsx
/**
 * S30 (Andy, 2026-10-28): the query box's speed is Codex's native speed.
 * Fast Mode off → standard, Fast → priority ("Fast"), Ultrafast → ultrafast.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexSpeedFor } from '../../providers/codexSpeed';

test('query-box speed maps to the Codex service tier', () => {
  assert.equal(codexSpeedFor(false, null), 'standard');
  assert.equal(codexSpeedFor(false, 'ultra'), 'standard', 'Fast Mode off wins over a stale speed');
  assert.equal(codexSpeedFor(true, 'fast'), 'priority');
  assert.equal(codexSpeedFor(true, 'ultra'), 'ultrafast');
  assert.equal(codexSpeedFor(true, null), 'priority', 'callers without a speed get Fast');
  assert.equal(codexSpeedFor(true, 'bogus'), 'priority');
});
