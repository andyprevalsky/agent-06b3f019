/**
 * Structural guard — macOS runners (and APFS default) are case-insensitive.
 * Two paths that differ only by letter case collide there even when Linux
 * checkout shows both files. Rollup then resolves imports to the wrong module
 * (v1.1.180 release: LiveViewFrame.tsx vs liveViewFrame.ts → "LiveViewFrame
 * is not exported"). Fail the suite when any directory has such a pair.
 *
 * Imports omit the extension, and the resolver tries `.ts` before `.tsx`, so
 * names that differ only by case once the extension is dropped collide too
 * (v1.1.229/230: `./AgentTreeListing` resolved to agentTreeListing.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC_DIR = path.resolve(__dirname, '../..');

const MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/;

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
    expect(caseCollisions((name) => name)).toEqual([]);
  });

  it('has no two modules whose extensionless import paths differ only by case', () => {
    expect(caseCollisions((name) => name.replace(MODULE_EXTENSION, ''))).toEqual([]);
  });
});

/** Directory groups whose `key(name)` values differ only by letter case. */
function caseCollisions(key: (name: string) => string): string[] {
  const collisions: string[] = [];
  for (const dir of walkDirs(SRC_DIR)) {
    const byLower = new Map<string, string[]>();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const lower = key(entry.name).toLowerCase();
      byLower.set(lower, [...(byLower.get(lower) ?? []), entry.name]);
    }
    for (const group of byLower.values()) {
      // foo.ts + foo.tsx is a same-case extension choice, not a case collision.
      if (new Set(group.map(key)).size < 2) continue;
      collisions.push(`${path.relative(SRC_DIR, dir)}: ${group.sort().join(' / ')}`);
    }
  }
  return collisions;
}
