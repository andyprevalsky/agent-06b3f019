#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { catalogAttachmentNames } from '../../domains/benchmarks/catalog';

// One name, a list, and the `attachments` alias all yield file names.
assert.deepEqual(catalogAttachmentNames({ attachment: 'deck.md' }), ['deck.md']);
assert.deepEqual(catalogAttachmentNames({ attachment: ['a.md', 'b.md'] }), ['a.md', 'b.md']);
assert.deepEqual(catalogAttachmentNames({ attachments: ['c.md'], attachment: 'ignored.md' }), [
  'c.md',
]);
// Malformed members never become asset URLs.
assert.deepEqual(catalogAttachmentNames({ attachment: [{}, 'ok.md', '', '  ', 3, null] }), [
  'ok.md',
]);
assert.deepEqual(catalogAttachmentNames({ attachment: { name: 'x' } }), []);
assert.deepEqual(catalogAttachmentNames({}), []);
process.stdout.write('benchmark catalog attachments: PASS\n');
