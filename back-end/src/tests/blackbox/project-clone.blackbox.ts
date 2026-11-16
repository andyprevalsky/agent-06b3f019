import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  localWorkspaceExecutor,
  registerWorkspaceExecutor,
  restoreWorkspace,
  unregisterWorkspaceExecutor,
} from '../../providers/projects/workspace';

test('project restore transfers the current tree without eagerly downloading historical blobs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-clone-'));
  const sessionId = randomUUID();
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args],
      {
        cwd,
        encoding: 'utf8',
      }
    ).trim();
  try {
    const remote = join(root, 'remote');
    const home = join(root, 'home');
    mkdirSync(remote);
    mkdirSync(home);
    git(remote, 'init', '-q', '-b', 'main');
    // Incompressible historical artifacts dominate the real Rose clone. They
    // are reachable history, but no longer part of the workspace being restored.
    const historical = randomBytes(1024 * 1024);
    writeFileSync(join(remote, 'old-artifact.bin'), historical);
    git(remote, 'add', '.');
    git(remote, 'commit', '-qm', 'historical artifact');
    const first = git(remote, 'rev-parse', 'HEAD');
    const blob = git(remote, 'rev-parse', 'HEAD:old-artifact.bin');
    unlinkSync(join(remote, 'old-artifact.bin'));
    writeFileSync(join(remote, 'current.txt'), 'current workspace\n');
    git(remote, 'add', '-A');
    git(remote, 'commit', '-qm', 'current tree');
    git(remote, 'config', 'uploadpack.allowFilter', 'true');
    registerWorkspaceExecutor(sessionId, localWorkspaceExecutor(home, process.env));
    const report = await restoreWorkspace(sessionId, {
      project: {
        id: 'fixture',
        name: 'Fixture',
        repoUrl: `file://${remote}`,
        defaultBranch: 'main',
        startupScript: null,
        startupTimeoutS: 60,
      },
      revision: 0,
      manifest: null,
      files: [],
      gitBundle: null,
      uncommittedPatch: null,
      redactions: [],
    });
    const checkout = join(home, 'workspace');
    assert.equal(report.checkout.source, 'remote');
    assert.deepEqual(report.warnings, []);
    assert.equal(readFileSync(join(checkout, 'current.txt'), 'utf8'), 'current workspace\n');
    const missing = git(checkout, 'rev-list', '--objects', '--missing=print', 'HEAD');
    assert.ok(
      missing.includes(`?${blob}`),
      'session preparation must not transfer obsolete historical blobs'
    );
    // Preserve complete history and lazy access, unlike a shallow clone.
    git(checkout, 'merge-base', '--is-ancestor', first, 'HEAD');
    assert.equal(git(checkout, 'rev-list', '--count', 'HEAD'), '2');
    const restored = execFileSync('git', ['show', `${first}:old-artifact.bin`], {
      cwd: checkout,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.deepEqual(restored, historical);
  } finally {
    unregisterWorkspaceExecutor(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});
