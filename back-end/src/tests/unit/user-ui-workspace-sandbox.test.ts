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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const writeUsers: Array<string | undefined> = [];
  return {
    writes,
    ran,
    writeUsers,
    files: {
      write: async (entries: { path: string; data: ArrayBuffer }[], opts?: { user: string }) => {
        writeUsers.push(opts?.user);
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
  assert.deepEqual(
    sandbox.writeUsers,
    ['user'],
    'filesystem snapshots must write runtime files as the non-root code user'
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

test('native CLI wrappers preserve argv and use the current task sandbox on PATH', async () => {
  const { withNativeCliWrappers } = await import('../../providers/codeSessionWorkspace');
  const base = workspace({ kind: 'seed' });
  const prepared = withNativeCliWrappers(base, [
    { id: 'cli-123', config: { native_template: true, command: '/usr/local/bin/yc' } },
    { id: 'remote-only', config: { command: '/usr/local/bin/remote' } },
    {
      id: 'public-cli',
      config: { native_template: true, command: '/usr/local/bin/public-cli', credential_files: [] },
    },
    { id: 'reserved', config: { native_template: true, command: '/usr/local/bin/rose' } },
    { id: 'bad-id; rm', config: { native_template: true, command: '/usr/local/bin/evil' } },
    { id: 'duplicate', config: { native_template: true, command: '/opt/bin/yc' } },
  ]);
  assert.ok(prepared);
  const wrapper = prepared.files.find((file) => file.path === '.rose/bin/yc');
  assert.equal(
    wrapper?.content.toString(),
    '#!/bin/sh\nexec node "$HOME/.rose/bin/rose" cli native \'cli-123\' -- "$@"\n'
  );
  assert.equal(prepared.files.filter((file) => file.path === '.rose/bin/yc').length, 1);
  assert.ok(
    !prepared.files.some((file) =>
      ['.rose/bin/remote', '.rose/bin/evil', '.rose/bin/public-cli'].includes(file.path)
    )
  );
  const env: Record<string, string> = {};
  applyUserUiSandboxEnvs(env, prepared);
  assert.ok(env.PATH.startsWith('/home/user/.rose/bin:'));
  assert.ok(
    env.PATH.split(':').includes('/home/user/.local/bin'),
    'native CLIs remain on runtime PATH'
  );
  assert.ok(env.PATH.split(':').includes('/home/user/.yc/bin'));
  assert.equal(env.BASH_ENV, '/home/user/.rose/native-cli-env.sh');
  const hook = prepared.files.find((file) => file.path === '.rose/native-cli-env.sh');
  assert.ok(hook);
  const temp = mkdtempSync(join(tmpdir(), 'rose-native-path-'));
  try {
    const bin = join(temp, 'wrapper-bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'yc'), '#!/bin/sh\necho wrapper\n', { mode: 0o755 });
    const script = join(temp, 'env.sh');
    writeFileSync(script, hook.content.toString().replace('/home/user/.rose/bin', bin));
    const result = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', 'command -v yc'], {
      env: { ...process.env, PATH: '/usr/bin:/bin', BASH_ENV: script },
      encoding: 'utf8',
    });
    assert.equal(
      result.trim(),
      join(bin, 'yc'),
      'noninteractive shells restore wrapper precedence'
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const sandbox = fakeSandbox();
  await writeUserUiWorkspaceToSandbox(
    { files: sandbox.files, commands: sandbox.commands },
    '/home/user',
    prepared
  );
  assert.ok(sandbox.writes.includes('/home/user/.rose/bin/yc'));
  assert.ok(
    sandbox.ran.some(
      (command) => command.startsWith('chmod 755 ') && command.includes('/home/user/.rose/bin/yc')
    )
  );
});
