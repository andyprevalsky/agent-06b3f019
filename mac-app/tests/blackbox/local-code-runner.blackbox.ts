/**
 * Blackbox tests for the `local-code-runner` domain (C14: code agents on this Mac).
 *
 * Observable surface:
 *   - folder grants: only real, symlink-resolved project folders; a session
 *     never runs outside a grant (symlink escapes refused)
 *   - ws-server spawn: the template ws-server.mjs under Electron-as-Node, cwd =
 *     the granted folder, private HOME, ROSE_PROJECT_WORKDIR, no host secrets
 *   - Terminal: a real Terminal.app window via osascript following the log
 *   - session manager: start → session_started{folder label}; no grant →
 *     session_failed(no_folder_granted) without spawning; stop/exit/redelivery
 *   - tunnel mux: one local socket per relay channel, frames both ways
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
  logIpc: vi.fn(),
}));

import {
  LocalFolderError,
  addGrant,
  appleScriptString,
  buildSessionEnv,
  buildTerminalAttachCommand,
  buildWsServerSpawn,
  displayFolder,
  parseControlMessage,
  reconnectDelayMs,
  removeGrant,
  resolveSessionFolder,
  setDefaultGrant,
  terminalTextFromFrame,
} from '../../main/domains/local-code-runner/service';
import {
  LocalSessionManager,
  type SessionDeps,
} from '../../main/domains/local-code-runner/serviceSession';
import { TunnelMux } from '../../main/domains/local-code-runner/serviceTunnel';
import type {
  ChildLike,
  ControlFromDevice,
  ExecSpec,
  FolderGrant,
  HomeFile,
  SocketLike,
  SpawnSpec,
  StartSessionCommand,
} from '../../main/domains/local-code-runner/types';

const realFs = {
  realpath: (p: string) => fs.realpathSync.native(p),
  isDirectory: (p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

let tmp: string;
let home: string;
let project: string;
let outside: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rose-local-code-')));
  home = path.join(tmp, 'home');
  project = path.join(home, 'Developer', 'rose');
  outside = path.join(tmp, 'secrets');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'x');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function expectFolderError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LocalFolderError);
    expect((error as LocalFolderError).code).toBe(code);
    return;
  }
  throw new Error(`expected LocalFolderError(${code})`);
}

function grantProject(grants: FolderGrant[] = [], folder = project, id = 'g1'): FolderGrant[] {
  return addGrant(grants, folder, realFs, { id, now: '2026-10-20T00:00:00.000Z', home });
}

describe('folder grants', () => {
  it('accepts a real folder once, labels it with ~, first grant is the default', () => {
    const grants = grantProject();
    expect(grants).toEqual([
      {
        id: 'g1',
        path: project,
        label: '~/Developer/rose',
        createdAt: '2026-10-20T00:00:00.000Z',
        isDefault: true,
      },
    ]);
    expect(grantProject(grants, project, 'g2')).toBe(grants);
    const two = grantProject(grants, outside, 'g2');
    expect(two.map((g) => g.isDefault)).toEqual([true, false]);
    expect(setDefaultGrant(two, 'g2').map((g) => g.isDefault)).toEqual([false, true]);
    expect(removeGrant(setDefaultGrant(two, 'g2'), 'g2')).toEqual([{ ...two[0], isDefault: true }]);
  });

  it('refuses relative, missing, file, disk-root and whole-home grants', () => {
    const reject = (folder: string) => {
      try {
        grantProject([], folder);
      } catch (error) {
        expect(error).toBeInstanceOf(LocalFolderError);
        expect((error as LocalFolderError).code).toBe('invalid_folder');
        return;
      }
      throw new Error(`expected ${folder} to be refused`);
    };
    reject('Developer/rose');
    reject(path.join(tmp, 'missing'));
    reject(path.join(project, 'README.md'));
    reject('/');
    reject(home);
  });

  it('a session runs only inside a grant; symlink escapes are refused', () => {
    expectFolderError(() => resolveSessionFolder(null, [], realFs), 'no_folder_granted');
    const grants = grantProject();
    expect(resolveSessionFolder(null, grants, realFs).folder).toBe(project);
    expect(resolveSessionFolder(path.join(project, 'src'), grants, realFs).folder).toBe(
      path.join(project, 'src')
    );
    expectFolderError(() => resolveSessionFolder(outside, grants, realFs), 'folder_not_granted');
    fs.symlinkSync(outside, path.join(project, 'escape'));
    expectFolderError(
      () => resolveSessionFolder(path.join(project, 'escape'), grants, realFs),
      'folder_not_granted'
    );
    expectFolderError(
      () => resolveSessionFolder(`${project}-evil`, grants, realFs),
      'folder_not_granted'
    );
  });

  it('displays home-relative paths', () => {
    expect(displayFolder(project, home)).toBe('~/Developer/rose');
    expect(displayFolder(home, home)).toBe('~');
    expect(displayFolder(outside, home)).toBe(outside);
  });
});

describe('ws-server spawn', () => {
  const base = {
    execPath: '/Applications/Rose.app/Contents/MacOS/Rose',
    wsServerPath: '/Applications/Rose.app/Contents/Resources/code-agent/claude-code/ws-server.mjs',
    folder: '/Users/andy/Developer/rose',
    sessionHome: '/Users/andy/Library/Application Support/Rose/local-code-sessions/t-1',
    port: 51234,
    readinessToken: 'ready-123',
    shellPath: '/opt/homebrew/bin:/usr/bin:/bin',
    hostEnv: {
      LANG: 'en_US.UTF-8',
      HOME: '/Users/andy',
      DATABASE_URL: 'postgres://secret',
      AWS_SECRET_ACCESS_KEY: 'nope',
      ANTHROPIC_API_KEY: 'host-key',
    },
    backendEnvs: {
      CLAUDE_CODE_GOAL: 'fix the bug',
      CLAUDE_CODE_OAUTH_TOKEN: 'user-own-token',
      GITHUB_TOKEN: 'never-forwarded',
      PORT: '1',
      HOME: '/',
    },
  };

  it('runs the template ws-server as Node in the granted folder with a private HOME', () => {
    const spec = buildWsServerSpawn({ ...base, provider: 'claude' });
    expect(spec.command).toBe(base.execPath);
    expect(spec.args).toEqual([base.wsServerPath]);
    expect(spec.cwd).toBe(base.folder);
    expect(spec.env).toEqual({
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_GOAL: 'fix the bug',
      CLAUDE_CODE_OAUTH_TOKEN: 'user-own-token',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: `${base.sessionHome}/.rose/bin:${base.shellPath}`,
      PORT: '51234',
      HOME: base.sessionHome,
      CLAUDE_CONFIG_DIR: `${base.sessionHome}/.claude`,
      ROSE_PROJECT_WORKDIR: base.folder,
      ROSE_LOCAL_WS_READINESS_TOKEN: 'ready-123',
    });
  });

  it('codex gets its own CODEX_HOME and the same workdir contract', () => {
    const spec = buildWsServerSpawn({
      ...base,
      provider: 'codex',
      backendEnvs: { CODEX_GOAL: 'g', CODEX_AUTH_JSON: '{}' },
    });
    expect(spec.env.CODEX_HOME).toBe(`${base.sessionHome}/.codex`);
    expect(spec.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(spec.env.ROSE_PROJECT_WORKDIR).toBe(base.folder);
    expect(spec.env.CODEX_AUTH_JSON).toBe('{}');
  });
});

describe('Terminal attach', () => {
  it('opens Terminal.app following the session log via osascript', () => {
    const logPath =
      '/Users/andy/Library/Application Support/Rose/local-code-sessions/t-1/terminal.log';
    expect(
      buildTerminalAttachCommand({ logPath, title: 'Rose code agent · ~/Developer/rose' })
    ).toEqual({
      file: 'osascript',
      args: [
        '-e',
        `tell application "Terminal" to do script "printf '\\\\033]0;%s\\\\007' 'Rose code agent · ~/Developer/rose'; clear; exec tail -n +1 -F '/Users/andy/Library/Application Support/Rose/local-code-sessions/t-1/terminal.log'"`,
        '-e',
        'tell application "Terminal" to activate',
      ],
    });
  });

  it('quotes hostile paths for both the shell and AppleScript', () => {
    const spec = buildTerminalAttachCommand({ logPath: `/tmp/a'b"c\\d.log`, title: 't' });
    expect(spec.args[1]).toContain(`'/tmp/a'\\\\''b\\"c\\\\d.log'`);
    expect(appleScriptString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('feeds CLI output, buffers and the exit line into the terminal log', () => {
    expect(terminalTextFromFrame('{"type":"stdout","data":"hello\\n"}')).toBe('hello\n');
    expect(terminalTextFromFrame('{"type":"buffer","data":"earlier"}')).toBe('earlier');
    expect(terminalTextFromFrame('{"type":"exit","code":0}')).toContain('exit 0');
    expect(terminalTextFromFrame('{"type":"code_agent_event","data":{}}')).toBeNull();
    expect(terminalTextFromFrame('not json')).toBeNull();
  });
});

describe('control messages and backoff', () => {
  it('parses only well-formed commands with relay paths on the relay prefix', () => {
    const start = {
      type: 'start_session',
      task_id: 't',
      agent_id: 'a',
      provider: 'claude',
      folder: null,
      envs: { CLAUDE_CODE_GOAL: 'g', BAD: 3 },
      relay_path: '/api/local-code-relay/t/device',
      home_files: [{ path: '.rose/bin/rose', content_base64: 'IyE=', executable: true }],
    };
    expect(parseControlMessage(JSON.stringify(start))).toEqual({
      ...start,
      envs: { CLAUDE_CODE_GOAL: 'g' },
    });
    for (const bad of ['../outside', '/etc/passwd', 'a/../../b', '']) {
      expect(
        parseControlMessage(
          JSON.stringify({
            ...start,
            home_files: [{ path: bad, content_base64: '', executable: false }],
          })
        )
      ).toBeNull();
    }
    expect(
      parseControlMessage(JSON.stringify({ ...start, relay_path: 'https://evil/x' }))
    ).toBeNull();
    expect(parseControlMessage(JSON.stringify({ ...start, provider: 'gemini' }))).toBeNull();
    expect(parseControlMessage('{"type":"stop_session","task_id":"t"}')).toEqual({
      type: 'stop_session',
      task_id: 't',
    });
    expect([0, 1, 2, 10].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 30000]);
  });
});

// ── session manager + tunnel with fakes ─────────────────────────────────

class FakeSocket extends EventEmitter implements SocketLike {
  sent: string[] = [];
  closedWith: number | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.emit('close');
  }
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}

class FakeChild implements ChildLike {
  killed: string[] = [];
  private exitListeners: Array<(code: number | null) => void> = [];
  kill(signal?: NodeJS.Signals): void {
    this.killed.push(signal ?? 'SIGTERM');
  }
  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }
  exit(code: number): void {
    for (const listener of this.exitListeners) listener(code);
  }
}

function harness(overrides: Partial<SessionDeps> = {}) {
  const control: ControlFromDevice[] = [];
  const spawned: SpawnSpec[] = [];
  const terminals: ExecSpec[] = [];
  const tunnels: FakeSocket[] = [];
  const locals: FakeSocket[] = [];
  const children: FakeChild[] = [];
  const order: string[] = [];
  const written: Array<{ sessionHome: string; files: HomeFile[] }> = [];
  let grants = grantProject();
  const deps: SessionDeps = {
    grants: () => grants,
    fs: realFs,
    home,
    execPath: '/Rose',
    hostEnv: {},
    shellPath: () => '/usr/bin',
    wsServerPath: (provider) => `/res/${provider}/ws-server.mjs`,
    allocatePort: async () => 40001,
    newToken: () => 'tok',
    makeSessionHome: async (taskId) => path.join(tmp, 'sessions', taskId),
    writeHomeFiles: async (sessionHome, files) => {
      order.push(`home:${files.length}`);
      written.push({ sessionHome, files });
    },
    terminalLogPath: (sessionHome) => path.join(sessionHome, 'terminal.log'),
    spawn: (spec) => {
      order.push('spawn');
      spawned.push(spec);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    waitForReady: async () => true,
    openTunnel: async () => {
      const tunnel = new FakeSocket();
      tunnels.push(tunnel);
      return tunnel;
    },
    connectLocal: () => {
      const local = new FakeSocket();
      locals.push(local);
      return local;
    },
    appendTerminal: vi.fn(),
    openTerminal: async (spec) => {
      terminals.push(spec);
    },
    sendControl: (message) => control.push(message),
    now: () => '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
  return {
    manager: new LocalSessionManager(deps),
    control,
    spawned,
    terminals,
    tunnels,
    locals,
    children,
    order,
    written,
    setGrants: (next: FolderGrant[]) => {
      grants = next;
    },
  };
}

function startCommand(overrides: Partial<StartSessionCommand> = {}): StartSessionCommand {
  return {
    type: 'start_session',
    task_id: 'task-1',
    agent_id: 'agent-1',
    provider: 'claude',
    folder: null,
    envs: { CLAUDE_CODE_GOAL: 'fix' },
    relay_path: '/api/local-code-relay/task-1/device',
    home_files: [],
    ...overrides,
  };
}

describe('session manager', () => {
  it('starts in the default grant, reports its label, opens Terminal and a tunnel', async () => {
    const h = harness();
    await h.manager.start(startCommand());
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0].cwd).toBe(project);
    expect(h.spawned[0].args).toEqual(['/res/claude/ws-server.mjs']);
    expect(h.spawned[0].env.ROSE_PROJECT_WORKDIR).toBe(project);
    expect(h.control).toEqual([
      { type: 'session_started', task_id: 'task-1', folder: '~/Developer/rose' },
    ]);
    expect(h.tunnels).toHaveLength(1);
    await vi.waitFor(() => expect(h.terminals).toHaveLength(1));
    expect(h.terminals[0].file).toBe('osascript');
    expect(h.terminals[0].args[1]).toContain(path.join(tmp, 'sessions', 'task-1', 'terminal.log'));
    expect(h.manager.views()).toEqual([
      {
        taskId: 'task-1',
        agentId: 'agent-1',
        provider: 'claude',
        folder: '~/Developer/rose',
        startedAt: '2026-10-20T00:00:00.000Z',
      },
    ]);
    // A redelivered start only re-acknowledges.
    await h.manager.start(startCommand());
    expect(h.spawned).toHaveLength(1);
    expect(h.control).toHaveLength(2);
  });

  it('no grant: fails with no_folder_granted and never spawns', async () => {
    const h = harness();
    h.setGrants([]);
    await h.manager.start(startCommand());
    expect(h.spawned).toEqual([]);
    expect(h.control).toEqual([
      expect.objectContaining({
        type: 'session_failed',
        task_id: 'task-1',
        code: 'no_folder_granted',
      }),
    ]);
  });

  it('a folder outside every grant is refused before spawning', async () => {
    const h = harness();
    await h.manager.start(startCommand({ folder: outside }));
    expect(h.spawned).toEqual([]);
    expect(h.control[0]).toEqual(expect.objectContaining({ code: 'folder_not_granted' }));
  });

  it('a ws-server that never becomes ready is killed and reported', async () => {
    const h = harness({ waitForReady: async () => false });
    await h.manager.start(startCommand());
    expect(h.children[0].killed).toEqual(['SIGKILL']);
    expect(h.control[0]).toEqual(expect.objectContaining({ code: 'spawn_failed' }));
    expect(h.manager.liveTaskIds()).toEqual([]);
  });

  it('stop terminates ws-server; an exit is reported once', async () => {
    const h = harness();
    await h.manager.start(startCommand());
    await h.manager.start(
      startCommand({ task_id: 'task-2', relay_path: '/api/local-code-relay/task-2/device' })
    );
    h.manager.stop('task-1');
    expect(h.children[0].killed).toEqual(['SIGTERM']);
    h.children[1].exit(0);
    expect(h.control.at(-1)).toEqual({ type: 'session_exited', task_id: 'task-2', code: 0 });
    expect(h.manager.liveTaskIds()).toEqual([]);
  });

  it('re-opens the tunnel of a live session after the backend comes back', async () => {
    const h = harness();
    await h.manager.start(startCommand());
    h.tunnels[0].emit('close');
    await h.manager.reattachTunnels();
    expect(h.tunnels).toHaveLength(2);
    await h.manager.reattachTunnels();
    expect(h.tunnels).toHaveLength(2);
  });
});

describe('in-session Rose tools', () => {
  it('passes the Rose tool env through and keeps Mac-owned session keys', () => {
    const env = buildSessionEnv(
      {},
      {
        ROSE_TOOLS_URL: 'https://api.example.com/api/agent-tools/a',
        ROSE_TOOLS_TOKEN: 'tools',
        ROSE_AGENTS_URL: 'https://api.example.com/api/agents/graph',
        ROSE_UI_PUBLISH_TOKEN: 'ui',
        ROSE_PROJECT_STARTUP: '/home/user/startup.sh',
        ROSE_LOCAL_WS_READINESS_TOKEN: 'forged',
        GITHUB_TOKEN: 'never',
      }
    );
    expect(env).toEqual({
      ROSE_TOOLS_URL: 'https://api.example.com/api/agent-tools/a',
      ROSE_TOOLS_TOKEN: 'tools',
      ROSE_AGENTS_URL: 'https://api.example.com/api/agents/graph',
      ROSE_UI_PUBLISH_TOKEN: 'ui',
    });
  });

  it('writes the session HOME files before spawning ws-server', async () => {
    const h = harness();
    const files: HomeFile[] = [
      { path: '.rose/bin/rose', content_base64: 'IyE=', executable: true },
      { path: '.rose/mcp.json', content_base64: 'e30=', executable: false },
    ];
    await h.manager.start(startCommand({ home_files: files }));
    expect(h.order).toEqual(['home:2', 'spawn']);
    expect(h.written[0]).toEqual({ sessionHome: path.join(tmp, 'sessions', 'task-1'), files });
    expect(h.spawned[0].env.PATH).toBe(
      `${path.join(tmp, 'sessions', 'task-1')}/.rose/bin:/usr/bin`
    );
  });

  it('a HOME that cannot be prepared fails the start without spawning', async () => {
    const h = harness({
      writeHomeFiles: async () => {
        throw new Error('disk full');
      },
    });
    await h.manager.start(startCommand());
    expect(h.spawned).toEqual([]);
    expect(h.control[0]).toEqual(expect.objectContaining({ code: 'spawn_failed' }));
  });
});

describe('tunnel mux', () => {
  it('one local ws-server connection per relay channel, frames both ways', () => {
    const tunnel = new FakeSocket();
    const locals: FakeSocket[] = [];
    const mux = new TunnelMux(tunnel, () => {
      const local = new FakeSocket();
      locals.push(local);
      return local;
    });
    tunnel.emit('message', JSON.stringify({ op: 'open', ch: 1 }));
    tunnel.emit('message', JSON.stringify({ op: 'open', ch: 2 }));
    expect(locals).toHaveLength(2);
    // Data before the local socket opens is queued, then flushed.
    tunnel.emit(
      'message',
      JSON.stringify({ op: 'data', ch: 1, data: '{"type":"stdin","data":"x"}' })
    );
    expect(locals[0].sent).toEqual([]);
    locals[0].emit('open');
    expect(locals[0].sent).toEqual(['{"type":"stdin","data":"x"}']);
    locals[1].emit('message', Buffer.from('{"type":"stdout","data":"hi"}'));
    expect(JSON.parse(tunnel.sent.at(-1) ?? '')).toEqual({
      op: 'data',
      ch: 2,
      data: '{"type":"stdout","data":"hi"}',
    });
    tunnel.emit('message', JSON.stringify({ op: 'close', ch: 1 }));
    expect(locals[0].closedWith).toBe(1000);
    expect(mux.channelCount).toBe(1);
    locals[1].emit('close');
    expect(JSON.parse(tunnel.sent.at(-1) ?? '')).toEqual({ op: 'close', ch: 2 });
    tunnel.emit('close');
    expect(mux.channelCount).toBe(0);
  });
});
