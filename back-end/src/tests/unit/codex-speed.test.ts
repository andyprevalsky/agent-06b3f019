#!/usr/bin/env tsx
/**
 * S30 (Andy, 2026-10-28): an agent's speed is Codex's native speed.
 * standard → no tier, fast → priority ("Fast"), ultrafast → ultrafast.
 * Rows that predate Agent.speed keep their legacy Fast Mode flag (true → fast).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexSpeedFor } from '../../providers/codexSpeed';
import { agentSpeedFromRow } from '../../providers/rose/speed';

test('agent speed maps to the Codex service tier', () => {
  assert.equal(codexSpeedFor('standard'), 'standard');
  assert.equal(codexSpeedFor('fast'), 'priority');
  assert.equal(codexSpeedFor('ultrafast'), 'ultrafast');
});

test('stored rows resolve their speed before the Codex mapping', () => {
  const tier = (row: { speed: string | null; fastModeCacheEnabled: boolean }) =>
    codexSpeedFor(agentSpeedFromRow(row));
  assert.equal(tier({ speed: 'ultrafast', fastModeCacheEnabled: false }), 'ultrafast');
  assert.equal(tier({ speed: 'standard', fastModeCacheEnabled: true }), 'standard');
  assert.equal(
    tier({ speed: null, fastModeCacheEnabled: true }),
    'priority',
    'legacy Fast Mode row'
  );
  assert.equal(tier({ speed: null, fastModeCacheEnabled: false }), 'standard');
});
