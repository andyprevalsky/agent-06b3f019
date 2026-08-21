#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * Pins nonLocalDatabaseReason — the shared "is this DATABASE_URL local?"
 * predicate used by unit-test / checkpoint runners to refuse prod writes.
 */
import assert from 'node:assert/strict';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    console.error(`  ❌ ${name}`);
    throw error;
  }
}

test('refuses an unset DATABASE_URL', () => {
  assert.equal(nonLocalDatabaseReason(undefined), 'DATABASE_URL is not set');
  assert.equal(nonLocalDatabaseReason(''), 'DATABASE_URL is not set');
});

test('accepts localhost / 127.0.0.1 / [::1]', () => {
  // Synthetic URLs — must not reuse real .env DATABASE_URL values (secret scanner).
  assert.equal(nonLocalDatabaseReason('postgresql://unit:test@localhost:5432/unitdb'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://unit@127.0.0.1:5432/unitdb'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://unit@[::1]:5432/unitdb'), null);
});

test('refuses a remote host', () => {
  const reason = nonLocalDatabaseReason('postgresql://unit:test@db.example.test:5432/unitdb');
  assert.equal(reason, 'database host "db.example.test" is not local');
});

test('refuses an unparseable URL', () => {
  const reason = nonLocalDatabaseReason('not-a-url');
  assert.equal(reason, 'DATABASE_URL is not a parseable URL: not-a-url');
});

console.log('local-database-url: all tests passed');
