import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const mockState = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
  rm: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn(() => '/Users/test/Library/Application Support/Rose'),
  },
}));

vi.mock('fs/promises', () => ({
  default: { rm: mockState.rm },
  rm: mockState.rm,
}));

vi.mock('child_process', () => ({
  default: { execFile: mockState.execFile, spawn: mockState.spawn },
  execFile: mockState.execFile,
  spawn: mockState.spawn,
}));

const { prepareCredentialExchangeHandoff, __passkeyHandoffStateTest } =
  await import('../../main/domains/passkey-import/handoff-state');

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

type MockStream = EventEmitter & {
  setEncoding: ReturnType<typeof vi.fn>;
};

type MockChildProcess = EventEmitter & {
  stdout: MockStream;
  stderr: MockStream;
  kill: ReturnType<typeof vi.fn>;
};

function makeLaunchServicesDump(records: string[]): string {
  return records.join(__passkeyHandoffStateTest.LSREGISTER_RECORD_SEPARATOR);
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function createMockChildProcess(stdoutChunks: string[], stderr = '', code = 0): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter() as MockStream;
  child.stderr = new EventEmitter() as MockStream;
  child.stdout.setEncoding = vi.fn();
  child.stderr.setEncoding = vi.fn();
  child.kill = vi.fn();

  queueMicrotask(() => {
    for (const chunk of stdoutChunks) {
      child.stdout.emit('data', chunk);
    }
    if (stderr !== '') {
      child.stderr.emit('data', stderr);
    }
    child.emit('close', code, null);
  });

  return child;
}

function installedCredentialExchangeRecord(): string {
  return [
    'identifier: com.rose.desktop',
    'path: /Applications/Rose.app (0x1)',
    'activityTypes: P3HATASMP9:ASCredentialExchangeActivity, NOTIFICATION#P3HATASMP9:com.rose.desktop',
  ].join('\n');
}

function installSuccessfulSpawnMock(): void {
  let dumpCount = 0;
  mockState.spawn.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe(LSREGISTER);
    expect(args).toEqual(['-dump']);
    dumpCount += 1;
    return createMockChildProcess([
      dumpCount === 1
        ? makeLaunchServicesDump([
            installedCredentialExchangeRecord(),
            ['identifier: com.rose.desktop', 'path: /tmp/old-worktree/Rose.app (0x2)'].join('\n'),
            [
              'identifier: com.rose.desktop.PasskeyProvider',
              'path: /tmp/old-worktree/Rose.app/Contents/PlugIns/PasskeyProvider.appex (0x3)',
            ].join('\n'),
          ])
        : makeLaunchServicesDump([installedCredentialExchangeRecord()]),
    ]);
  });
}

function installSuccessfulExecFileMock(): void {
  const pgrepCounts = new Map<string, number>();
  const pidByPattern = new Map<string, number>();
  mockState.execFile.mockImplementation(
    (command: string, args: string[], _options: unknown, callback: ExecCallback) => {
      if (command === LSREGISTER && args[0] === '-dump') {
        callback(new RangeError('stdout maxBuffer length exceeded'), '', '');
        return;
      }

      if (command === 'pgrep') {
        const pattern = args[args.length - 1];
        const count = pgrepCounts.get(pattern) ?? 0;
        pgrepCounts.set(pattern, count + 1);
        if (!pidByPattern.has(pattern)) {
          pidByPattern.set(pattern, 1000 + pidByPattern.size);
        }
        callback(null, count === 0 ? `${pidByPattern.get(pattern)}\n` : '', '');
        return;
      }

      if (command === '/bin/kill') {
        callback(null, '', '');
        return;
      }

      if (command === 'pluginkit' && args[0] === '-m') {
        callback(
          null,
          '+    com.rose.desktop.PasskeyProvider(1.0)\t/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex',
          ''
        );
        return;
      }

      callback(null, '', '');
    }
  );
}

describe('passkey credential exchange handoff state', () => {
  beforeEach(() => {
    mockState.execFile.mockReset();
    mockState.spawn.mockReset();
    mockState.rm.mockClear();
    installSuccessfulExecFileMock();
    installSuccessfulSpawnMock();
    process.env.USER = 'test-user';
  });

  it('clears restart-sensitive macOS handoff stores before opening Passwords', async () => {
    const result = await prepareCredentialExchangeHandoff();

    expect(mockState.rm).toHaveBeenCalledWith(
      '/Users/test/Library/Application Support/Rose/credential-exchange-activity.json',
      { force: true }
    );

    for (const spec of __passkeyHandoffStateTest.RESTARTABLE_HANDOFF_PROCESS_SPECS) {
      expect(mockState.execFile).toHaveBeenCalledWith(
        'pgrep',
        ['-u', 'test-user', '-f', spec.pattern],
        expect.any(Object),
        expect.any(Function)
      );
    }
    expect(mockState.execFile).toHaveBeenCalledWith(
      '/bin/kill',
      expect.arrayContaining(['-TERM']),
      expect.any(Object),
      expect.any(Function)
    );

    expect(mockState.execFile).toHaveBeenCalledWith(
      LSREGISTER,
      ['-u', '/tmp/old-worktree/Rose.app'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockState.execFile).toHaveBeenCalledWith(
      LSREGISTER,
      ['-u', '/tmp/old-worktree/Rose.app/Contents/PlugIns/PasskeyProvider.appex'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockState.execFile).toHaveBeenCalledWith(
      LSREGISTER,
      ['-f', '/Applications/Rose.app'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockState.execFile).toHaveBeenCalledWith(
      'pluginkit',
      ['-a', '/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockState.execFile).toHaveBeenCalledWith(
      'pluginkit',
      ['-e', 'use', '-i', 'com.rose.desktop.PasskeyProvider'],
      expect.any(Object),
      expect.any(Function)
    );

    expect(result.staleLaunchServicesRecords).toEqual([
      '/tmp/old-worktree/Rose.app',
      '/tmp/old-worktree/Rose.app/Contents/PlugIns/PasskeyProvider.appex',
    ]);
    expect(result.pluginPath).toBe('/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex');
    expect(result.credentialExchangeLaunchServicesRecords).toEqual([
      'com.rose.desktop @ /Applications/Rose.app activities=P3HATASMP9:ASCredentialExchangeActivity, NOTIFICATION#P3HATASMP9:com.rose.desktop',
    ]);
  });

  it('streams LaunchServices dump instead of buffering it through execFile', async () => {
    const staleRecord = [
      'identifier: com.rose.desktop',
      'path: /tmp/large-dump/Rose.app (0x9)',
    ].join('\n');
    const largeUnrelatedRecords = Array.from({ length: 8000 }, (_, index) =>
      [
        `identifier: com.example.unrelated.${index}`,
        `path: /Applications/Unrelated-${index}.app (0x${index.toString(16)})`,
      ].join('\n')
    );
    const dump = makeLaunchServicesDump([...largeUnrelatedRecords, staleRecord]);

    mockState.spawn.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe(LSREGISTER);
      expect(args).toEqual(['-dump']);
      return createMockChildProcess(
        chunkText(
          mockState.spawn.mock.calls.length === 1
            ? dump
            : makeLaunchServicesDump([installedCredentialExchangeRecord()]),
          16384
        )
      );
    });

    const result = await prepareCredentialExchangeHandoff();

    expect(mockState.execFile).not.toHaveBeenCalledWith(
      LSREGISTER,
      ['-dump'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(result.staleLaunchServicesRecords).toEqual(['/tmp/large-dump/Rose.app']);
    expect(mockState.execFile).toHaveBeenCalledWith(
      LSREGISTER,
      ['-u', '/tmp/large-dump/Rose.app'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('escalates to SIGKILL when AuthenticationServicesAgent survives SIGTERM', async () => {
    let authAgentPgrepCount = 0;
    mockState.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (command === 'pgrep') {
          const pattern = args[args.length - 1];
          if (pattern === 'AuthenticationServicesAgent') {
            authAgentPgrepCount += 1;
            callback(null, authAgentPgrepCount <= 2 ? '4242\n' : '', '');
            return;
          }
          callback(new Error('no process'), '', '');
          return;
        }
        if (command === '/bin/kill') {
          callback(null, '', '');
          return;
        }
        if (command === 'pluginkit' && args[0] === '-m') {
          callback(
            null,
            '+    com.rose.desktop.PasskeyProvider(1.0)\t/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex',
            ''
          );
          return;
        }
        callback(null, '', '');
      }
    );

    const result = await prepareCredentialExchangeHandoff();

    expect(result.restartedProcesses).toContain('AuthenticationServicesAgent');
    expect(mockState.execFile).toHaveBeenCalledWith(
      '/bin/kill',
      ['-TERM', '4242'],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockState.execFile).toHaveBeenCalledWith(
      '/bin/kill',
      ['-KILL', '4242'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('fails loudly when PluginKit does not point at the installed Rose provider', async () => {
    mockState.execFile.mockImplementation(
      (command: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (command === LSREGISTER && args[0] === '-dump') {
          callback(new RangeError('stdout maxBuffer length exceeded'), '', '');
          return;
        }
        if (command === 'pluginkit' && args[0] === '-m') {
          callback(null, '+    com.rose.desktop.PasskeyProvider(1.0)\t/tmp/old/Rose.app', '');
          return;
        }
        callback(null, '', '');
      }
    );

    await expect(prepareCredentialExchangeHandoff()).rejects.toThrow(
      'PluginKit did not register com.rose.desktop.PasskeyProvider'
    );
  });

  it('fails before opening Passwords when LaunchServices does not route credential exchange to installed Rose', async () => {
    mockState.spawn.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe(LSREGISTER);
      expect(args).toEqual(['-dump']);
      return createMockChildProcess([
        makeLaunchServicesDump([
          [
            'identifier: com.rose.desktop',
            'path: /Applications/Rose.app (0x1)',
            'activityTypes: NOTIFICATION#P3HATASMP9:com.rose.desktop',
          ].join('\n'),
        ]),
      ]);
    });

    await expect(prepareCredentialExchangeHandoff()).rejects.toThrow(
      'LaunchServices is not routing ASCredentialExchangeActivity to /Applications/Rose.app'
    );
  });

  it('detects stale Rose app records even when the identifier line is missing', () => {
    const scan = __passkeyHandoffStateTest.scanRoseLaunchServicesDump(
      makeLaunchServicesDump([
        [
          'path: /tmp/stale/Rose.app (0x2)',
          'activityTypes: P3HATASMP9:ASCredentialExchangeActivity',
        ].join('\n'),
        installedCredentialExchangeRecord(),
      ]),
      '/Applications/Rose.app'
    );

    expect(scan.stalePaths).toEqual(['/tmp/stale/Rose.app']);
  });
});
