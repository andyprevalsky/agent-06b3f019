import { readdirSync } from 'node:fs';
import { dirname, extname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

function caseCollisions(directory: string): string[] {
  const names = new Map<string, string>();
  const collisions: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') collisions.push(...caseCollisions(join(directory, entry.name)));
      continue;
    }
    if (!entry.isFile() || !['.ts', '.tsx'].includes(extname(entry.name))) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    const stem = parse(entry.name).name.toLowerCase();
    const previous = names.get(stem);
    if (previous) collisions.push(`${join(directory, previous)} ↔ ${entry.name}`);
    else names.set(stem, entry.name);
  }
  return collisions;
}

describe('source module resolution', () => {
  it('has no case-folded TS/TSX basename collisions for extensionless imports', () => {
    expect(caseCollisions(sourceRoot)).toEqual([]);
  });
});
