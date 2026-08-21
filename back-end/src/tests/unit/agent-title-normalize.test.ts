#!/usr/bin/env tsx
/**
 * `normalizeTitle` is the only pure part of the sidebar-title generator: it turns
 * a raw model response into something storable. Everything it strips is a shape
 * the model actually emits despite the prompt (quotes, a `Label:` preamble, a
 * trailing period, a chatty second line), so each case here is a real failure
 * mode of the generated sidebar label — not a hypothetical.
 */

import assert from 'node:assert/strict';
import { AGENT_TITLE_MAX_CHARS, normalizeTitle } from '../../providers/generateAgentTitle';
import { updateAgentSchema } from '../../domains/agents/types';

// Clean input is returned untouched.
assert.equal(normalizeTitle('Soho Sushi Reservation'), 'Soho Sushi Reservation');
assert.equal(normalizeTitle('  Browser Agent Stall  '), 'Browser Agent Stall');

// Wrapping quotes / backticks.
assert.equal(normalizeTitle('"Soho Sushi Reservation"'), 'Soho Sushi Reservation');
assert.equal(normalizeTitle("'Soho Sushi Reservation'"), 'Soho Sushi Reservation');
assert.equal(normalizeTitle('`Soho Sushi Reservation`'), 'Soho Sushi Reservation');
assert.equal(normalizeTitle('""Soho Sushi Reservation""'), 'Soho Sushi Reservation');

// Leading `Label:` / `Title:` preamble, case- and space-insensitive.
assert.equal(normalizeTitle('Label: Simple Arithmetic'), 'Simple Arithmetic');
assert.equal(normalizeTitle('Title: Simple Arithmetic'), 'Simple Arithmetic');
assert.equal(normalizeTitle('  label:Simple Arithmetic'), 'Simple Arithmetic');
assert.equal(normalizeTitle('TITLE   :   Simple Arithmetic'), 'Simple Arithmetic');
// Only a leading preamble is stripped — a colon inside the label survives.
assert.equal(normalizeTitle('P1: Browser Agent Stall'), 'P1: Browser Agent Stall');

// Trailing punctuation.
for (const [raw, expected] of [
  ['Simple Arithmetic.', 'Simple Arithmetic'],
  ['Simple Arithmetic,', 'Simple Arithmetic'],
  ['Simple Arithmetic;', 'Simple Arithmetic'],
  ['Simple Arithmetic:', 'Simple Arithmetic'],
  ['Simple Arithmetic!', 'Simple Arithmetic'],
  ['Simple Arithmetic...', 'Simple Arithmetic'],
] as const) {
  assert.equal(normalizeTitle(raw), expected, raw);
}

// Only the first line is kept — the model sometimes appends an explanation.
assert.equal(
  normalizeTitle('Soho Sushi Reservation\nThis label summarizes the booking task.'),
  'Soho Sushi Reservation'
);
assert.equal(normalizeTitle('Label: Soho Sushi\n\nWhy: it books a table.'), 'Soho Sushi');
// Leading blank lines are trimmed before the split, so a preamble of newlines
// does not swallow the label.
assert.equal(
  normalizeTitle('\n\nSoho Sushi Reservation\ntrailing chatter'),
  'Soho Sushi Reservation'
);

// Nothing usable → null, so the caller leaves `title` null and the UI falls back
// to the goal.
for (const empty of ['', '   ', '\n\n', '""', 'Label:', '  title :  ', '...']) {
  assert.equal(normalizeTitle(empty), null, JSON.stringify(empty));
}

// Over-long labels are truncated to the hard cap, with no dangling whitespace.
const long = normalizeTitle('x'.repeat(AGENT_TITLE_MAX_CHARS + 40));
assert.equal(long, 'x'.repeat(AGENT_TITLE_MAX_CHARS));

const wordBoundary = normalizeTitle(`${'x'.repeat(AGENT_TITLE_MAX_CHARS - 1)}   trailing words`);
assert.equal(wordBoundary, 'x'.repeat(AGENT_TITLE_MAX_CHARS - 1), 'truncation must trimEnd');

const atLimit = normalizeTitle('y'.repeat(AGENT_TITLE_MAX_CHARS));
assert.equal(atLimit?.length, AGENT_TITLE_MAX_CHARS, 'a label at the cap is not truncated');

// The generator's cap and the rename API's cap must not drift: a normalized
// title has to be storable through PATCH /api/agents/:id.
assert.equal(
  updateAgentSchema.safeParse({ title: 'x'.repeat(AGENT_TITLE_MAX_CHARS) }).success,
  true,
  'a title at AGENT_TITLE_MAX_CHARS must pass updateAgentSchema'
);
assert.equal(
  updateAgentSchema.safeParse({ title: 'x'.repeat(AGENT_TITLE_MAX_CHARS + 1) }).success,
  false,
  'updateAgentSchema must reject a title above AGENT_TITLE_MAX_CHARS'
);
assert.equal(updateAgentSchema.safeParse({ title: null }).success, true, 'null clears the rename');
assert.equal(updateAgentSchema.safeParse({ title: '' }).success, false, 'empty title is rejected');
assert.equal(
  updateAgentSchema.safeParse({ title: '   ' }).success,
  false,
  'whitespace-only title is rejected'
);

process.stdout.write('PASS agent title normalization\n');
