#!/usr/bin/env tsx

import assert from 'node:assert';
import 'dotenv/config';

import { clearsChatStallGuard } from '../../providers/rose/cerebrasRoute';

// User-visible output satisfies the chat first-content deadline.
assert.equal(clearsChatStallGuard('content'), true, 'content must clear the chat stall guard');
assert.equal(clearsChatStallGuard('tool_call'), true, 'tool_call must clear the chat stall guard');

// Reasoning is requested OFF on the exclusive chat route; a reasoning trickle
// is a throttled stream, not progress, and must NOT defeat the stall guard
// (regression: 2026-07-19 web_search lifecycle ratchet breach — a rate-cap
// queued GLM stream dripped reasoning tokens, cleared the guard, and left the
// chat silent for 5.6s before first content).
assert.equal(
  clearsChatStallGuard('reasoning'),
  false,
  'reasoning must not clear the chat stall guard'
);

// Non-output chunk kinds never satisfy the deadline.
assert.equal(clearsChatStallGuard('usage'), false, 'usage must not clear the chat stall guard');
assert.equal(clearsChatStallGuard('done'), false, 'done must not clear the chat stall guard');
