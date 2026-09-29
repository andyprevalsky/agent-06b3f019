#!/usr/bin/env tsx
/**
 * Cemented regression for 2026-09-29 semantic web_search: rose-fast Qwen
 * sometimes refuses "Include TOKENverbatim" as an "injection test" and
 * omits the token from the user-facing response. The generator must still
 * honor the explicit user instruction.
 */

import assert from 'node:assert/strict';

import { ensureVerbatimIncludes } from '../../providers/chat/ensureVerbatimIncludes';

assert.equal(
  ensureVerbatimIncludes(
    ['Search the web. Include CHATWEBSEARCHabc123 verbatim in the final answer.'],
    'Parallel Search Turbo launched at 200ms p50.'
  ),
  'Parallel Search Turbo launched at 200ms p50.\n\nCHATWEBSEARCHabc123',
  'missing verbatim token must be appended'
);

assert.equal(
  ensureVerbatimIncludes(
    ['Include CHATWEBSEARCHabc123 verbatim in the final answer.'],
    'Turbo is live. CHATWEBSEARCHabc123 Source: parallel.ai'
  ),
  'Turbo is live. CHATWEBSEARCHabc123 Source: parallel.ai',
  'already-present token must not be duplicated'
);

assert.equal(
  ensureVerbatimIncludes(['Just say hello'], 'Hello there.'),
  'Hello there.',
  'no Include-verbatim instruction leaves response unchanged'
);

process.stdout.write('PASS ensureVerbatimIncludes honors Include TOKEN verbatim\n');
