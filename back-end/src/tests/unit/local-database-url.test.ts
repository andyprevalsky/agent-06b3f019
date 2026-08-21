#!/usr/bin/env tsx
/**
 * Pins the shared local-vs-remote DATABASE_URL guard used by unit runners and
 * checkpoint scripts so a production pooler URL never looks "local".
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

test('accepts localhost, loopback IPv4, and bracketed IPv6', () => {
  assert.equal(nonLocalDatabaseReason('postgresql://postgres@localhost:5432/victoria'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://postgres@127.0.0.1:5432/victoria'), null);
  assert.equal(nonLocalDatabaseReason('postgresql://postgres@[::1]:5432/victoria'), null);
});

test('refuses unset, unparseable, and remote hosts', () => {
  assert.equal(nonLocalDatabaseReason(undefined), 'DATABASE_URL is not set');
  assert.match(nonLocalDatabaseReason('not-a-url') ?? '', /DATABASE_URL is not a parseable URL/);
  assert.equal(
    nonLocalDatabaseReason('postgresql://postgres@db.example.com:5432/victoria'),
    'database host "db.example.com" is not local'
  );
});

console.log('local-database-url: all assertions passed');
