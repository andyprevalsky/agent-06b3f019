/**
 * Git workspace fixture for the code-session inspect blackbox (split out of
 * code-session-inspect.blackbox.ts to keep it under max-lines).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare origin with main pushed; `<home>/workspace` on a local branch with a local commit and edits. */
export function seedInspectWorkspace(fixtureDir: string, home: string): { origin: string } {
  const origin = join(fixtureDir, `origin-${randomUUID()}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const workspace = join(home, 'workspace');
  mkdirSync(home, { recursive: true });
  execFileSync('git', ['clone', '-q', origin, workspace], { stdio: 'ignore' });
  git(workspace, 'config', 'user.name', 'Test');
  git(workspace, 'config', 'user.email', 'test@example.com');
  git(workspace, 'checkout', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'README.md'), 'line one\n');
  git(workspace, 'add', '-A');
  git(workspace, 'commit', '-q', '-m', 'initial');
  git(workspace, 'push', '-q', 'origin', 'main');
  git(workspace, 'checkout', '-q', '-b', 'rose/feature-1');
  writeFileSync(join(workspace, 'feature.txt'), 'committed locally\n');
  git(workspace, 'add', 'feature.txt');
  git(workspace, 'commit', '-q', '-m', 'local commit');
  writeFileSync(join(workspace, 'README.md'), 'line one\nuncommitted edit\n');
  writeFileSync(join(home, 'CLAUDE.md'), '# template scaffolding: commit and message the user\n');
  return { origin };
}
