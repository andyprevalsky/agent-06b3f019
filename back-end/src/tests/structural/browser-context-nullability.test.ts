#!/usr/bin/env tsx
/* eslint-disable no-console */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(backendDir, relativePath), 'utf8');
}

function testBrowserContextContextIdIsNullable() {
  const schema = read('prisma/schema.prisma');
  assert(
    /model\s+BrowserContext\s+\{[\s\S]*?\n\s+contextId\s+String\?\s+@unique/.test(schema),
    'BrowserContext.contextId must be nullable because Steel profile IDs are created lazily'
  );
}

function testMigrationBackfillsEmptySentinel() {
  const migration = read(
    'prisma/migrations/20260508010000_nullable_browser_context_context_id/migration.sql'
  );
  assert(
    migration.includes('WHERE "contextId" = \'\';'),
    'Migration must backfill existing empty-string contextId sentinels'
  );
  assert(
    migration.includes('ALTER TABLE "BrowserContext" ALTER COLUMN "contextId" DROP NOT NULL;'),
    'Migration must drop the BrowserContext.contextId NOT NULL constraint'
  );
  assert(
    migration.indexOf('ALTER TABLE "BrowserContext" ALTER COLUMN "contextId" DROP NOT NULL;') <
      migration.indexOf('SET "contextId" = NULL'),
    'Migration must drop NOT NULL before replacing empty-string sentinels with NULL'
  );
}

function testSteelDoesNotCreateEmptyContextId() {
  const source = read('src/providers/steel/session.ts');
  assert(
    !source.includes("contextId: ''"),
    'Steel provider must not create BrowserContext rows with empty contextId'
  );
  assert(
    source.includes('contextId: null'),
    'Steel provider must create pending BrowserContext rows with null contextId'
  );
  assert(
    source.includes('profileId: dbContext.contextId ?? undefined'),
    'Steel session creation must omit profileId while the DB context is pending'
  );
  assert(
    source.includes('where: { id: dbContextId, contextId: null }'),
    'Steel provider must atomically claim the first profile for pending contexts'
  );
  assert(
    source.includes('Concurrent profile init detected'),
    'Steel provider must detect concurrent first-profile creation'
  );
  assert(
    source.includes('steel.sessions.release(session.id)'),
    'Steel provider must release a superseded first-profile session before retrying'
  );
}

function main() {
  testBrowserContextContextIdIsNullable();
  testMigrationBackfillsEmptySentinel();
  testSteelDoesNotCreateEmptyContextId();
  console.log('browser context nullability structural tests passed');
}

main();
