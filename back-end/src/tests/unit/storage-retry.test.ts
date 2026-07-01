#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  ❌ ${name}`);
  }
}

const storageSource = readFileSync(join(__dirname, '../../providers/storage.ts'), 'utf8');

test('Supabase attachment uploads use canonical retry helper', () => {
  assert.match(storageSource, /import\s+\{\s*retryWithBackoff\s*\}\s+from\s+['"]\.\/retry['"]/);
  assert.match(storageSource, /retryWithBackoff\(\s*async\s*\(\)\s*=>/);
  assert.match(storageSource, /component:\s*['"]StorageUpload['"]/);
});

test('upload retry wraps the Supabase upload operation, not file pointer creation', () => {
  const retryIndex = storageSource.indexOf('retryWithBackoff');
  const uploadIndex = storageSource.indexOf('.upload(storagePath, fileBuffer');
  const pointerIndex = storageSource.indexOf('export async function processUploadedFile');

  assert.ok(retryIndex >= 0, 'retryWithBackoff call missing');
  assert.ok(uploadIndex > retryIndex, 'Supabase upload must be inside the retry block');
  assert.ok(pointerIndex > uploadIndex, 'retry must stay scoped to uploadToStorage');
});

if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`\n${passed}/2 storage retry tests passed`);
