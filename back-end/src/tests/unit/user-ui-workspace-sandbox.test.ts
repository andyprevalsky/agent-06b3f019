#!/usr/bin/env tsx
/**
 * Session start in an E2B sandbox (fake sandbox, no network):
 *   - every workspace writes the CLI + preview host + skills and chmods the CLI;
 *   - nothing captures screenshots at session start, published or not: the
 *     agent runs `rose-ui screenshot --current` when it needs them (C17);
 *   - no UI folder is written: the agent runs `rose-ui pull`;
 *   - the published-version env reaches the sandbox env.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withRoseSkills } from '../../providers/codeSessionWorkspace';
import { USER_UI_PREVIEW_HOST_PATH, userUiToolFiles } from '../../providers/userUi/seed';
import {
  applyUserUiSandboxEnvs,
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
  const base: UserUiWorkspace = {
    files: userUiToolFiles(),
    envs: { ROSE_UI_PUBLISH_URL: 'https://api.example/api/user-ui/versions' },
    source,
  };
  const withSkills = withRoseSkills(base, true);
  assert.ok(withSkills !== null);
  return withSkills;
}

test('published user: tooling and skills written, no session-start capture', async () => {
  const sandbox = fakeSandbox();
  await writeUserUiWorkspaceToSandbox(
    { files: sandbox.files, commands: sandbox.commands },
    '/home/user',
    workspace({ kind: 'active', versionId: 'v1' })
  );
  assert.ok(sandbox.writes.includes('/home/user/.rose/bin/rose-ui'));
  assert.ok(sandbox.writes.includes(`/home/user/${USER_UI_PREVIEW_HOST_PATH}`));
  for (const root of ['.rose/skills', '.claude/skills', '.agents/skills']) {
    assert.ok(sandbox.writes.includes(`/home/user/${root}/rose-ui/SKILL.md`), root);
    assert.ok(sandbox.writes.includes(`/home/user/${root}/talk-to-user/SKILL.md`), root);
  }
  assert.ok(!sandbox.writes.some((path) => path.startsWith('/home/user/rose_user_ui/')));
  assert.deepEqual(sandbox.ran, ['chmod 755 /home/user/.rose/bin/rose-ui']);
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
