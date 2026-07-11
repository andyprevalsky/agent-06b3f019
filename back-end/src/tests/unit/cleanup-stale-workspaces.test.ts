#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import { resolveActiveWorkspaces } from '../../../scripts/cleanup-stale-workspaces';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

test('keeps directory and secondary workspace identities active', () => {
  const queries: string[] = [];
  const active = resolveActiveWorkspaces('fix-query-input-controls', (query) => {
    queries.push(query);
    if (queries.length === 1) return 'repo-rose';
    return ['raleigh|fix-query-input-controls', 'san-jose|sms-onboarding'].join('\n');
  });

  assert.equal(active.repositoryId, 'repo-rose');
  assert.deepEqual(active.directoryNames, new Set(['raleigh', 'san-jose']));
  assert.deepEqual(
    active.resourceNames,
    new Set(['raleigh', 'fix-query-input-controls', 'san-jose', 'sms-onboarding'])
  );
  assert.match(queries[0], /SELECT DISTINCT repository_id/);
  assert.match(queries[1], /WHERE state != 'archived' AND repository_id = 'repo-rose'/);
});

test('fails closed when the current workspace has no repository match', () => {
  assert.throws(
    () => resolveActiveWorkspaces('missing-workspace', () => ''),
    /Could not resolve a Conductor repository/
  );
});

test('fails closed when the current workspace matches multiple repositories', () => {
  assert.throws(
    () => resolveActiveWorkspaces('ambiguous-workspace', () => 'repo-one\nrepo-two'),
    /matched multiple Conductor repositories/
  );
});

test('fails closed when the repository has no active workspace identities', () => {
  let queryCount = 0;
  assert.throws(
    () =>
      resolveActiveWorkspaces('raleigh', () => {
        queryCount += 1;
        return queryCount === 1 ? 'repo-rose' : '';
      }),
    /No active Conductor workspaces found/
  );
});

test('fails closed when one active identity belongs to multiple workspaces', () => {
  let queryCount = 0;
  assert.throws(
    () =>
      resolveActiveWorkspaces('raleigh', () => {
        queryCount += 1;
        return queryCount === 1 ? 'repo-rose' : 'raleigh|shared-name\nsan-jose|shared-name';
      }),
    /Active Conductor identity shared-name is ambiguous/
  );
});

console.log('cleanup stale workspace identity tests passed');
