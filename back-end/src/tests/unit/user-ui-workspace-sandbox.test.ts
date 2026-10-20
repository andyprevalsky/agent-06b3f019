#!/usr/bin/env tsx
/**
 * Session start in an E2B sandbox (fake sandbox, no network):
 *   - every workspace writes the CLI + preview host and chmods the CLI;
 *   - a user with a published version also gets a detached
 *     `rose-ui screenshot --current` so screenshots/current/ is ready early;
 *   - a seed (never published) workspace does not start a capture;
 *   - the published-version env reaches the sandbox env.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { USER_UI_PREVIEW_HOST_PATH, userUiToolFiles } from '../../providers/userUi/seed';
import {
  applyUserUiSandboxEnvs,
  currentScreenshotsCommand,
  userUiPublishedBaseUrl,
  writeUserUiWorkspaceToSandbox,
  type UserUiWorkspace,
} from '../../providers/userUi/workspace';

function fakeSandbox() {
  const writes: string[] = [];
  const ran: string[] = [];
  return {
    writes,
    ran,
    files: {
      write: async (entries: { path: string; data: ArrayBuffer }[]) => {
        writes.push(...entries.map((e) => e.path));
      },
    },
    commands: {
      run: async (cmd: string) => {
        ran.push(cmd);
        return { exitCode: 0 };
      },
    },
  };
}

function workspace(source: UserUiWorkspace['source']): UserUiWorkspace {
  return {
    files: [{ path: 'rose_user_ui/README.md', content: Buffer.from('x') }, ...userUiToolFiles()],
    envs: { ROSE_UI_PUBLISH_URL: 'https://api.example/api/user-ui/versions' },
    source,
  };
}

test('published user: tooling written and a detached current capture starts', async () => {
  const sandbox = fakeSandbox();
  await writeUserUiWorkspaceToSandbox(
    { files: sandbox.files, commands: sandbox.commands },
    '/home/user',
    workspace({ kind: 'active', versionId: 'v1' })
  );
  assert.ok(sandbox.writes.includes('/home/user/.rose/bin/rose-ui'));
  assert.ok(sandbox.writes.includes(`/home/user/${USER_UI_PREVIEW_HOST_PATH}`));
  assert.deepEqual(sandbox.ran, [
    'chmod 755 /home/user/.rose/bin/rose-ui',
    currentScreenshotsCommand('/home/user'),
  ]);
  assert.equal(
    currentScreenshotsCommand('/home/user'),
    'nohup /home/user/.rose/bin/rose-ui screenshot --current --quiet > /home/user/.rose/current-screenshots.log 2>&1 &'
  );
});

test('seed user: no capture is started', async () => {
  const sandbox = fakeSandbox();
  await writeUserUiWorkspaceToSandbox(
    { files: sandbox.files, commands: sandbox.commands },
    '/home/user/',
    workspace({ kind: 'seed' })
  );
  assert.deepEqual(sandbox.ran, ['chmod 755 /home/user/.rose/bin/rose-ui']);
});

test('published base URL follows USERCONTENT_BASE_URL and reaches the sandbox env', () => {
  const previous = process.env.USERCONTENT_BASE_URL;
  try {
    delete process.env.USERCONTENT_BASE_URL;
    assert.equal(
      userUiPublishedBaseUrl('v1', 'https://api.example'),
      'https://api.example/usercontent/v1/'
    );
    process.env.USERCONTENT_BASE_URL = 'https://usercontent.example/';
    assert.equal(
      userUiPublishedBaseUrl('v1', 'https://api.example'),
      'https://usercontent.example/usercontent/v1/'
    );
  } finally {
    if (previous === undefined) delete process.env.USERCONTENT_BASE_URL;
    else process.env.USERCONTENT_BASE_URL = previous;
  }
  const envs: Record<string, string> = {};
  const ws = workspace({ kind: 'active', versionId: 'v1' });
  ws.envs.ROSE_UI_PUBLISHED_BASE_URL = 'https://api.example/usercontent/v1/';
  ws.envs.ROSE_UI_PUBLISHED_VERSION_ID = 'v1';
  applyUserUiSandboxEnvs(envs, ws);
  assert.equal(envs.ROSE_UI_PUBLISHED_VERSION_ID, 'v1');
  assert.equal(envs.ROSE_UI_PUBLISHED_BASE_URL, 'https://api.example/usercontent/v1/');
  assert.match(envs.PATH, /^\/home\/user\/\.rose\/bin:/);
});
