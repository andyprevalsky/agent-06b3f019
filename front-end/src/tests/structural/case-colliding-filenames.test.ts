/**
 * Structural guard — macOS runners (and APFS default) are case-insensitive.
 * Two paths that differ only by letter case collide there even when Linux
 * checkout shows both files. Rollup then resolves imports to the wrong module
 * (v1.1.180 release: LiveViewFrame.tsx vs liveViewFrame.ts → "LiveViewFrame
 * is not exported"). Fail the suite when any directory has such a pair.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../..');

function walkDirs(root: string): string[] {
  const dirs: string[] = [root];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    dirs.push(...walkDirs(path.join(root, entry.name)));
  }
  return dirs;
}

describe('front-end source filenames are unique under case-insensitive FS', () => {
  it('has no two files in the same directory that differ only by case', () => {
    const collisions: string[] = [];
    for (const dir of walkDirs(SRC_DIR)) {
      const names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name);
      const byLower = new Map<string, string[]>();
      for (const name of names) {
        const key = name.toLowerCase();
        const group = byLower.get(key) ?? [];
        group.push(name);
        byLower.set(key, group);
      }
      for (const group of byLower.values()) {
        if (group.length < 2) continue;
        collisions.push(`${path.relative(SRC_DIR, dir)}: ${group.sort().join(' / ')}`);
      }
    }
    expect(collisions).toEqual([]);
  });
});
