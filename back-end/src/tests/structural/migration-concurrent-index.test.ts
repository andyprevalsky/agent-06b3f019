#!/usr/bin/env tsx
import * as fs from 'fs';
import * as path from 'path';

const migrationsDir = path.resolve(__dirname, '../../../prisma/migrations');
const unsafeMigrations: string[] = [];

for (const entry of fs.readdirSync(migrationsDir).sort()) {
  const relativePath = path.join(entry, 'migration.sql');
  const migrationPath = path.join(migrationsDir, relativePath);
  if (!fs.existsSync(migrationPath)) continue;

  const sql = fs
    .readFileSync(migrationPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--.*$/gm, '');
  if (!/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sql)) continue;

  const statements = sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  const isIsolatedConcurrentIndex =
    statements.length === 1 &&
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statements[0]);
  if (!isIsolatedConcurrentIndex) unsafeMigrations.push(relativePath);
}

if (unsafeMigrations.length > 0) {
  console.error('Concurrent indexes must be isolated in one-statement migrations:');
  for (const migration of unsafeMigrations) console.error(`  - ${migration}`);
  console.error(
    'Prisma sends a multi-statement PostgreSQL migration as one transaction, where CREATE INDEX CONCURRENTLY is forbidden.'
  );
  process.exit(1);
}

console.log('All concurrent indexes are isolated in one-statement migrations.');
