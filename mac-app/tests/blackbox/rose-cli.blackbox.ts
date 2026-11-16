/**
 * Blackbox tests for the `rose-cli` domain: the Rose Mac app provides the
 * `rose` CLI itself, so importing a project never needs `npm i -g @roselabs.ai/cli`.
 *
 * Observable surface:
 *   - launcher: `ELECTRON_RUN_AS_NODE=1 exec '<app>' '<cli>' "$@"`, every path
 *     single-quoted; run as a program it forwards argv verbatim through app
 *     paths with spaces, quotes, `$` and command substitutions
 *   - a moved app: the launcher exits 127 with an actionable repair message
 *   - install: ~/.rose/bin created 0700, launcher 0755 via an atomic rename (no
 *     temp file left, even on failure, never written through a symlink); a
 *     stale launcher or mode is repaired; a current one is not rewritten
 *   - failures: missing bundled CLI, unwritable home, failing write →
 *     { success: false, error } (never a throw)
 *   - location: packaged → <resources>/rose-cli/bin/rose.mjs; dev (compiled
 *     dist/main/main/domains/rose-cli) → <repo>/scripts/lib/rose-sync/bin/rose.mjs
 *   - packaging: build.extraResources ships scripts/lib/rose-sync as rose-cli
 *     (.mjs + package.json) and the CLI imports only node: built-ins and siblings
 *   - runtime: startRoseCli writes the launcher at app start and registers
 *     roseCli:ensureInstalled | pickProjectFolder | importProject | cancelImport;
 *     the picker opens on the focused window; importProject runs the real
 *     launcher and broadcasts roseCli:importEvent (service details:
 *     rose-cli-import.blackbox.ts)
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const electronState = vi.hoisted(() => ({
  home: '',
  isPackaged: true,
  handleCalls: [] as string[],
  handlers: new Map<string, IpcHandler>(),
  appEvents: [] as string[],
  focusedWindow: null as object | null,
  senderWindow: null as object | null,
  sent: [] as Array<{ channel: string; payload: unknown }>,
  showOpenDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (name: string) => {
      if (name !== 'home' || electronState.home === '') {
        throw new Error(`app.getPath(${name}) unavailable`);
      }
      return electronState.home;
    },
    on: (event: string) => {
      electronState.appEvents.push(event);
    },
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      electronState.handleCalls.push(channel);
      electronState.handlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            electronState.sent.push({ channel, payload });
          },
        },
      },
    ],
    getFocusedWindow: () => electronState.focusedWindow,
    fromWebContents: () => electronState.senderWindow,
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => electronState.showOpenDialog(...args) as unknown,
  },
}));

// The login-shell PATH probe is covered by its own suite; keep runtime tests hermetic.
vi.mock('../../main/base/shellEnv', () => ({
  getAugmentedEnv: () => ({ PATH: '/usr/bin:/bin' }),
}));

vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
  logIpc: vi.fn(),
}));

import {
  CANCEL_IMPORT_CHANNEL,
  CLI_ENTRY_RELATIVE,
  ENSURE_INSTALLED_CHANNEL,
  IMPORT_EVENT_CHANNEL,
  IMPORT_PROJECT_CHANNEL,
  PACKAGED_CLI_DIR,
  PICK_FOLDER_CHANNEL,
} from '../../main/domains/rose-cli/config';
import { launcherIo, writeLauncherAtomic } from '../../main/domains/rose-cli/repo';
import { startRoseCli } from '../../main/domains/rose-cli/runtime';
import {
  buildLauncherScript,
  cliEntryPath,
  ensureLauncher,
  launcherPathFor,
  shellSingleQuote,
} from '../../main/domains/rose-cli/service';
import type {
  LauncherIo,
  LauncherTarget,
  RoseCliImportStartResult,
  RoseCliInstallResult,
} from '../../main/domains/rose-cli/types';

const MAC_APP_ROOT = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(MAC_APP_ROOT, '..');
const ROSE_SYNC_DIR = path.join(REPO_ROOT, 'scripts', 'lib', 'rose-sync');
/** An app folder name a naive launcher would break on (and `$(...)` would run in). */
const ODD_DIR = `Rose's "Apps" $(touch pwned) x`;
/** Stand-in CLI: reports the argv and ELECTRON_RUN_AS_NODE it was started with. */
const ECHO_CLI =
  'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), ' +
  'runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));\n';
const TRICKY_ARGS = ['agent-init', 'two words', "it's", '$HOME', '"quoted"', '$(touch pwned)'];

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rose-cli-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake Rose.app: this test's Node as the app binary, the echo CLI as rose.mjs. */
function fakeApp(name = ODD_DIR): { execPath: string; cliEntry: string; resources: string } {
  const contents = path.join(tmp, name, 'Rose.app', 'Contents');
  const execPath = path.join(contents, 'MacOS', "Ro'se");
  const resources = path.join(contents, 'Resources');
  const cliEntry = path.join(resources, PACKAGED_CLI_DIR, CLI_ENTRY_RELATIVE);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.symlinkSync(process.execPath, execPath);
  fs.mkdirSync(path.dirname(cliEntry), { recursive: true });
  fs.writeFileSync(cliEntry, ECHO_CLI);
  return { execPath, cliEntry, resources };
}

function targetIn(home: string, app = fakeApp()): LauncherTarget {
  return { launcherPath: launcherPathFor(home), execPath: app.execPath, cliEntry: app.cliEntry };
}

function run(
  file: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(file, args, {
    cwd: tmp,
    // No ELECTRON_RUN_AS_NODE from the test runner: the launcher must set it.
    env: { PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe('launcher script', () => {
  it('single-quotes shell words, escaping embedded single quotes', () => {
    expect(shellSingleQuote('/Applications/Rose.app')).toBe(`'/Applications/Rose.app'`);
    expect(shellSingleQuote("Rose's App")).toBe(`'Rose'\\''s App'`);
    expect(shellSingleQuote('')).toBe(`''`);
  });

  it('runs the app binary as Node on the bundled CLI and never touches PATH or rc files', () => {
    const script = buildLauncherScript({
      execPath: '/Applications/Rose.app/Contents/MacOS/Rose',
      cliEntry: '/Applications/Rose.app/Contents/Resources/rose-cli/bin/rose.mjs',
    });
    expect(script).toBe(
      [
        '#!/bin/sh',
        '# rose CLI launcher. The Rose Mac app rewrites this file on every start so it',
        '# always runs the CLI bundled with the installed app, wherever the app lives.',
        `if [ ! -x '/Applications/Rose.app/Contents/MacOS/Rose' ]; then`,
        `  printf '%s\\n' 'rose: the Rose app is no longer at /Applications/Rose.app/Contents/MacOS/Rose. Open Rose once to repair this launcher.' >&2`,
        '  exit 127',
        'fi',
        `ELECTRON_RUN_AS_NODE=1 exec '/Applications/Rose.app/Contents/MacOS/Rose' '/Applications/Rose.app/Contents/Resources/rose-cli/bin/rose.mjs' "$@"`,
        '',
      ].join('\n')
    );
    expect(script).not.toMatch(/PATH=|\.zshrc|\.bashrc|\.bash_profile|\.profile/);
  });

  it('forwards argv verbatim through app paths with spaces, quotes and $(...)', () => {
    const app = fakeApp();
    const launcher = path.join(tmp, 'rose-launcher.sh');
    fs.writeFileSync(launcher, buildLauncherScript(app));

    const result = run('/bin/sh', [launcher, ...TRICKY_ARGS]);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: TRICKY_ARGS, runAsNode: '1' });
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
  });

  it('exits 127 with a repair message once the app is gone', () => {
    const execPath = path.join(tmp, ODD_DIR, 'Rose.app', 'Contents', 'MacOS', 'Rose');
    const launcher = path.join(tmp, 'rose-launcher.sh');
    fs.writeFileSync(
      launcher,
      buildLauncherScript({ execPath, cliEntry: path.join(tmp, 'missing', 'rose.mjs') })
    );

    const result = run('/bin/sh', [launcher, 'status']);

    expect(result.status).toBe(127);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `rose: the Rose app is no longer at ${execPath}. Open Rose once to repair this launcher.\n`
    );
    expect(fs.existsSync(path.join(tmp, 'pwned'))).toBe(false);
  });
});

describe('ensureLauncher install', () => {
  it('creates ~/.rose/bin (0700) and an executable 0755 launcher that runs the CLI', async () => {
    const home = path.join(tmp, 'home');
    const target = targetIn(home);

    const result = await ensureLauncher(target, launcherIo);

    const launcher = path.join(home, '.rose', 'bin', 'rose');
    expect(result).toEqual({ success: true, path: launcher });
    expect(modeOf(path.join(home, '.rose'))).toBe(0o700);
    expect(modeOf(path.join(home, '.rose', 'bin'))).toBe(0o700);
    expect(modeOf(launcher)).toBe(0o755);
    expect(fs.readdirSync(path.join(home, '.rose', 'bin'))).toEqual(['rose']);
    expect(fs.readFileSync(launcher, 'utf8')).toBe(buildLauncherScript(target));

    const ran = run(launcher, TRICKY_ARGS);
    expect(ran.status).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({ argv: TRICKY_ARGS, runAsNode: '1' });
  });

  it('rewrites a stale launcher or mode and leaves a current one alone', async () => {
    const home = path.join(tmp, 'home');
    const target = targetIn(home);
    const writes: string[] = [];
    const io: LauncherIo = {
      ...launcherIo,
      writeLauncher: async (p, content) => {
        writes.push(p);
        await launcherIo.writeLauncher(p, content);
      },
    };

    await ensureLauncher(target, io);
    expect(await ensureLauncher(target, io)).toEqual({ success: true, path: target.launcherPath });
    expect(writes).toHaveLength(1);

    fs.chmodSync(target.launcherPath, 0o644);
    await ensureLauncher(target, io);
    expect(writes).toHaveLength(2);
    expect(modeOf(target.launcherPath)).toBe(0o755);

    // The user moved Rose.app: the next start points the launcher at the new place.
    const moved = targetIn(home, fakeApp('Moved Apps'));
    expect(await ensureLauncher(moved, io)).toEqual({ success: true, path: moved.launcherPath });
    expect(writes).toHaveLength(3);
    expect(fs.readFileSync(moved.launcherPath, 'utf8')).toBe(buildLauncherScript(moved));
    expect(fs.readdirSync(path.dirname(moved.launcherPath))).toEqual(['rose']);
  });

  it('keeps the permissions of an existing ~/.rose', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.rose'), { recursive: true });
    fs.chmodSync(path.join(home, '.rose'), 0o755);

    expect((await ensureLauncher(targetIn(home), launcherIo)).success).toBe(true);
    expect(modeOf(path.join(home, '.rose'))).toBe(0o755);
  });

  it('replaces a symlinked launcher instead of writing through it', async () => {
    const home = path.join(tmp, 'home');
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    const target = targetIn(home);
    fs.mkdirSync(path.dirname(target.launcherPath), { recursive: true });
    fs.symlinkSync(victim, target.launcherPath);

    expect((await ensureLauncher(target, launcherIo)).success).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(target.launcherPath).isFile()).toBe(true);
    expect(fs.readFileSync(target.launcherPath, 'utf8')).toBe(buildLauncherScript(target));
  });

  it('leaves no temp file behind when the atomic rename fails', async () => {
    const launcher = path.join(tmp, 'home', '.rose', 'bin', 'rose');
    fs.mkdirSync(path.join(launcher, 'not-a-file'), { recursive: true });

    await expect(writeLauncherAtomic(launcher, '#!/bin/sh\n')).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(launcher))).toEqual(['rose']);
  });
});

describe('ensureLauncher failures', () => {
  it('refuses to write a launcher when the bundled CLI is missing', async () => {
    const home = path.join(tmp, 'home');
    const target = { ...targetIn(home), cliEntry: path.join(tmp, 'gone', 'rose.mjs') };

    const result = await ensureLauncher(target, launcherIo);

    expect(result).toEqual({
      success: false,
      error: `This Rose app build is missing its rose CLI (${target.cliEntry}). Reinstall Rose from roselabs.ai.`,
    });
    expect(fs.existsSync(path.join(home, '.rose'))).toBe(false);
  });

  it('reports an unwritable home as an error result', async () => {
    const home = path.join(tmp, 'home-is-a-file');
    fs.writeFileSync(home, '');
    const target = targetIn(home);

    const result = await ensureLauncher(target, launcherIo);

    expect(result.success).toBe(false);
    expect(result.path).toBeUndefined();
    expect(result.error).toContain(`Could not install the rose CLI at ${target.launcherPath}: `);
  });

  it('turns a failing write into an error result instead of throwing', async () => {
    const target = targetIn(path.join(tmp, 'home'));
    const io: LauncherIo = {
      ...launcherIo,
      writeLauncher: () => Promise.reject(new Error('disk full')),
    };

    expect(await ensureLauncher(target, io)).toEqual({
      success: false,
      error: `Could not install the rose CLI at ${target.launcherPath}: disk full`,
    });
  });
});

describe('bundled CLI location', () => {
  it('packaged: <resources>/rose-cli/bin/rose.mjs', () => {
    expect(
      cliEntryPath({
        isPackaged: true,
        resourcesPath: "/Applications/Rose's Copy.app/Contents/Resources",
        moduleDir: '/ignored',
      })
    ).toBe("/Applications/Rose's Copy.app/Contents/Resources/rose-cli/bin/rose.mjs");
  });

  it('dev: the compiled module dir resolves to the checkout scripts/lib/rose-sync CLI', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(MAC_APP_ROOT, 'package.json'), 'utf8')) as {
      main: string;
    };
    // tsc emits main/** under dist/main, so this module compiles to dist/main/main/domains/rose-cli.
    expect(pkg.main).toBe('dist/main/main/index.js');
    const moduleDir = path.join(MAC_APP_ROOT, 'dist', 'main', 'main', 'domains', 'rose-cli');

    const entry = cliEntryPath({ isPackaged: false, resourcesPath: '/unused', moduleDir });

    expect(entry).toBe(path.join(ROSE_SYNC_DIR, 'bin', 'rose.mjs'));
    expect(fs.existsSync(entry)).toBe(true);
  });
});

describe('packaging', () => {
  it('ships scripts/lib/rose-sync as Resources/rose-cli with only .mjs files and package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(MAC_APP_ROOT, 'package.json'), 'utf8')) as {
      build: { extraResources: Array<{ from: string; to: string; filter?: string[] }> };
    };
    const entry = pkg.build.extraResources.find((resource) => resource.to === PACKAGED_CLI_DIR);

    expect(entry).toEqual({
      from: '../scripts/lib/rose-sync',
      to: PACKAGED_CLI_DIR,
      filter: ['**/*.mjs', 'package.json'],
    });
    expect(path.resolve(MAC_APP_ROOT, entry?.from ?? '')).toBe(ROSE_SYNC_DIR);
    const cliPackage = JSON.parse(
      fs.readFileSync(path.join(ROSE_SYNC_DIR, 'package.json'), 'utf8')
    ) as { bin: Record<string, string> };
    expect(cliPackage.bin.rose).toBe(CLI_ENTRY_RELATIVE);
  });

  it('the bundled CLI imports only node: built-ins and sibling .mjs files', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory() && item.name !== 'node_modules') walk(full);
        else if (item.name.endsWith('.mjs')) files.push(full);
      }
    };
    walk(ROSE_SYNC_DIR);
    expect(files).toContain(path.join(ROSE_SYNC_DIR, 'bin', 'rose.mjs'));

    const patterns = [
      /^\s*import\s[^;]*?\bfrom\s*["']([^"']+)["']/gm,
      /^\s*export\s*(?:\*|\{)[^;]*?\bfrom\s*["']([^"']+)["']/gm,
      /^\s*import\s*["']([^"']+)["']/gm,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1];
          if (specifier.startsWith('node:')) continue;
          const resolved = path.resolve(path.dirname(file), specifier);
          const bundled =
            specifier.startsWith('.') &&
            resolved.startsWith(`${ROSE_SYNC_DIR}${path.sep}`) &&
            resolved.endsWith('.mjs') &&
            fs.existsSync(resolved);
          if (!bundled) offenders.push(`${path.relative(ROSE_SYNC_DIR, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('runtime', () => {
  function handler(channel: string): IpcHandler {
    const registered = electronState.handlers.get(channel);
    expect(registered, `ipcMain.handle(${channel})`).toBeDefined();
    return registered as IpcHandler;
  }

  function useFakeApp(): { app: ReturnType<typeof fakeApp>; home: string } {
    const app = fakeApp();
    const home = path.join(tmp, 'home');
    electronState.home = home;
    electronState.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', {
      value: app.resources,
      configurable: true,
      writable: true,
    });
    return { app, home };
  }

  afterEach(() => {
    Reflect.deleteProperty(process, 'resourcesPath');
  });

  // Declared first on purpose: startRoseCli runs once per process, and this
  // case asserts the write it does at app start.
  it('writes the launcher at app start and serves roseCli:ensureInstalled', async () => {
    const { app, home } = useFakeApp();
    const launcher = path.join(home, '.rose', 'bin', 'rose');

    startRoseCli();
    startRoseCli();
    expect(electronState.handleCalls).toEqual([
      ENSURE_INSTALLED_CHANNEL,
      PICK_FOLDER_CHANNEL,
      IMPORT_PROJECT_CHANNEL,
      CANCEL_IMPORT_CHANNEL,
    ]);
    expect(electronState.appEvents).toEqual(['before-quit']);

    await vi.waitFor(() => expect(fs.existsSync(launcher)).toBe(true), { timeout: 10_000 });
    expect(fs.readFileSync(launcher, 'utf8')).toBe(
      buildLauncherScript({ execPath: process.execPath, cliEntry: app.cliEntry })
    );

    const ensureInstalled = (): Promise<RoseCliInstallResult> =>
      handler(ENSURE_INSTALLED_CHANNEL)({}) as Promise<RoseCliInstallResult>;
    expect(await ensureInstalled()).toEqual({ success: true, path: launcher });

    Object.defineProperty(process, 'resourcesPath', { value: path.join(tmp, 'empty') });
    const missing = await ensureInstalled();
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('missing its rose CLI');

    electronState.home = '';
    expect(await ensureInstalled()).toEqual({
      success: false,
      error: 'Could not locate the rose CLI: app.getPath(home) unavailable',
    });
  });

  it('opens the folder picker on the focused window and maps its result', async () => {
    startRoseCli();
    const pick = handler(PICK_FOLDER_CHANNEL);
    const options = {
      title: 'Choose a project to import',
      buttonLabel: 'Import',
      properties: ['openDirectory'],
    };
    const focused = { id: 'focused' };
    const requester = { id: 'requester' };

    electronState.focusedWindow = focused;
    electronState.senderWindow = requester;
    electronState.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/Users/me/Developer/my app'],
    });
    expect(await pick({ sender: {} })).toEqual({
      canceled: false,
      path: '/Users/me/Developer/my app',
    });
    expect(electronState.showOpenDialog).toHaveBeenLastCalledWith(focused, options);

    electronState.focusedWindow = null;
    electronState.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await pick({ sender: {} })).toEqual({ canceled: true });
    expect(electronState.showOpenDialog).toHaveBeenLastCalledWith(requester, options);

    electronState.senderWindow = null;
    electronState.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [] });
    expect(await pick({ sender: {} })).toEqual({ canceled: true });
    expect(electronState.showOpenDialog).toHaveBeenLastCalledWith(options);

    electronState.showOpenDialog.mockRejectedValueOnce(new Error('dialog unavailable'));
    expect(await pick({ sender: {} })).toEqual({ canceled: true });
  });

  it('runs rose import through the launcher and broadcasts its events', async () => {
    useFakeApp();
    startRoseCli();
    electronState.sent.length = 0;

    const rejected = (await handler(IMPORT_PROJECT_CHANNEL)(
      {},
      { action: 'scan', folder: 'relative/path', loginCode: 'x', apiUrl: 'https://x' }
    )) as RoseCliImportStartResult;
    expect(rejected).toEqual({ error: 'Choose a project folder on this Mac.' });

    const started = (await handler(IMPORT_PROJECT_CHANNEL)(
      {},
      { action: 'detect', argv: ['--evil'] }
    )) as RoseCliImportStartResult;
    expect(started).toEqual({ runId: expect.any(String) });
    const runId = 'runId' in started ? started.runId : '';

    await vi.waitFor(() => expect(electronState.sent).toHaveLength(2), { timeout: 15_000 });
    expect(electronState.sent).toEqual([
      {
        channel: IMPORT_EVENT_CHANNEL,
        payload: { argv: ['import', 'detect', '--json'], runAsNode: '1', runId },
      },
      { channel: IMPORT_EVENT_CHANNEL, payload: { runId, event: 'exit', code: 0 } },
    ]);
    expect(await handler(CANCEL_IMPORT_CHANNEL)({}, runId)).toBeUndefined();
  });
});
