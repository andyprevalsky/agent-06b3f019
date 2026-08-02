#!/usr/bin/env tsx
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

function testBaselineCreatesNullableContextId() {
  // The migration history was squashed to a single pg_dump baseline on
  // 2026-07-06 (prisma/migrations/00000000000000_init). The historical
  // empty-string -> NULL backfill is baked into prod data and irrelevant to a
  // fresh deploy (no rows to backfill); the durable invariant is that the
  // baseline creates BrowserContext.contextId as NULLABLE and UNIQUE.
  const baseline = read('prisma/migrations/00000000000000_init/migration.sql');
  const table = baseline.match(/CREATE TABLE (?:public\.)?"BrowserContext"\s*\(([\s\S]+?)\n\)\s*;/);
  assert(table, 'Baseline must create the BrowserContext table');
  const contextIdCol = table[1]
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^"contextId"\s/.test(l));
  assert(contextIdCol, 'Baseline BrowserContext must define a contextId column');
  assert(
    !/\bNOT NULL\b/i.test(contextIdCol),
    'BrowserContext.contextId must be nullable in the baseline (Steel profile IDs are created lazily)'
  );
  assert(
    /CREATE UNIQUE INDEX "BrowserContext_contextId_key"/.test(baseline),
    'Baseline must keep the unique index on BrowserContext.contextId'
  );
}

// Anon-profile handling was extracted from session.ts into profileBinding.ts,
// which red-lined assertions that grepped session.ts alone even though every
// invariant still held. Scan the whole provider so an extraction cannot fail a
// satisfied invariant -- and so a violation cannot hide in a new sibling file.
function steelProviderSource(): string {
  const dir = path.join(backendDir, 'src/providers/steel');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => read(path.join('src/providers/steel', f)))
    .join('\n');
}

function testSteelDoesNotCreateEmptyContextId() {
  const source = steelProviderSource();
  const resumeSource = read('src/providers/steel/sessionResume.ts');
  assert(
    !source.includes("contextId: ''"),
    'Steel provider must not create BrowserContext rows with empty contextId'
  );
  assert(
    source.includes('contextId: null'),
    'Steel provider must create pending BrowserContext rows with null contextId'
  );
  assert(
    source.includes('profileId: profile.profileId'),
    'Steel session creation must omit profileId while the DB context is pending'
  );
  assert(
    source.includes('BENCHMARK_ANON_STEEL_PROFILE'),
    'Steel provider must support benchmark anon mode for fresh per-agent profiles'
  );
  assert(
    source.includes('benchmarkAnonProfilesByAgent'),
    'Benchmark anon Steel profiles must be keyed outside BrowserContext so user profile IDs are not overwritten'
  );
  // Was a log-string grep; the refactor replaced that log line with an explicit
  // predicate, so assert the predicate exists, excludes both non-persisting
  // profile sources, and actually guards the BrowserContext write.
  assert(
    source.includes('export function shouldWriteSteelProfileToBrowserContext'),
    'Steel provider must expose an explicit predicate for whether a profile may be persisted to BrowserContext'
  );
  assert(
    source.includes("!profile.profileSource.startsWith('benchmark_anon')") &&
      source.includes("profile.profileSource !== 'steel_session_auth_read_only'"),
    'Benchmark anon and read-only auth Steel profiles must never overwrite BrowserContext.contextId'
  );
  assert(
    source.includes('if (!shouldWriteSteelProfileToBrowserContext(profile)) {'),
    'The BrowserContext profile write must be gated by shouldWriteSteelProfileToBrowserContext'
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
    source.includes('await releaseSteelRemoteSession(session.id)') &&
      source.includes('await steel.sessions.release(sessionId)'),
    'Steel provider must release a superseded first-profile session before retrying'
  );
  const disabledSystemCursorCount =
    (source.match(/systemCursor:\s*false/g) || []).length +
    (resumeSource.match(/systemCursor:\s*false/g) || []).length;
  assert(
    disabledSystemCursorCount >= 2,
    'Steel session creation and resume must disable the native debug cursor so browser-agent recordings show only the Rose overlay cursor'
  );
}

function main() {
  testBrowserContextContextIdIsNullable();
  testBaselineCreatesNullableContextId();
  testSteelDoesNotCreateEmptyContextId();
  process.stdout.write('browser context nullability structural tests passed\n');
}

main();
