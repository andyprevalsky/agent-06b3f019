import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
  },
}));

vi.mock('child_process', () => ({
  default: {
    execFile: mockState.execFile,
    spawn: mockState.spawn,
  },
  execFile: mockState.execFile,
  spawn: mockState.spawn,
}));

const {
  getPasskeyAutoFillStatus,
  isRoseProviderEnabled,
  parseCredentialExchangeEnabledDefault,
  parsePluginKitProviderEnabled,
  requestPasskeyAutoFillPermission,
} = await import('../../main/domains/passkey-permission/service');

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function execFileSucceeds(command: string, stdout: string, stderr = ''): void {
  mockState.execFile.mockImplementationOnce(
    (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      expect(_command).toBe(command);
      callback(null, stdout, stderr);
    }
  );
}

function execFileFails(command: string, error: Error): void {
  mockState.execFile.mockImplementationOnce(
    (_command: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      expect(_command).toBe(command);
      callback(error, '', '');
    }
  );
}

function spawnHelper(options: { stdout?: string; stderr?: string; code?: number }): void {
  mockState.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as MockChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (options.stdout !== undefined) child.stdout.emit('data', options.stdout);
      if (options.stderr !== undefined) child.stderr.emit('data', options.stderr);
      child.emit('close', options.code ?? 0, null);
    });
    return child;
  });
}

describe('passkey permission service', () => {
  beforeEach(() => {
    mockState.execFile.mockReset();
    mockState.spawn.mockReset();
    process.resourcesPath = '/Applications/Rose.app/Contents/Resources';
  });

  it('detects enabled Rose credential provider from pluginkit output', () => {
    const output = `
+    com.rose.desktop.PasskeyProvider(1.0)
\t            Path = /Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex
     com.other.Provider(1.0)
`;

    expect(parsePluginKitProviderEnabled(output, 'com.rose.desktop.PasskeyProvider')).toBe(true);
  });

  it('does not treat a disabled Rose credential provider as enabled', () => {
    const output = `
     com.rose.desktop.PasskeyProvider(1.0)
\t            Path = /Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex
+    com.other.Provider(1.0)
`;

    expect(parsePluginKitProviderEnabled(output, 'com.rose.desktop.PasskeyProvider')).toBe(false);
  });

  it('parses the macOS Credential Exchange developer default', () => {
    expect(parseCredentialExchangeEnabledDefault('1\n')).toBe(true);
    expect(parseCredentialExchangeEnabledDefault('YES\n')).toBe(true);
    expect(parseCredentialExchangeEnabledDefault('true\n')).toBe(true);
    expect(parseCredentialExchangeEnabledDefault('0\n')).toBe(false);
    expect(parseCredentialExchangeEnabledDefault('')).toBe(false);
  });

  it('reads current AutoFill and developer-gate status', async () => {
    execFileSucceeds('defaults', 'YES\n');
    execFileSucceeds('pluginkit', '+    com.rose.desktop.PasskeyProvider(1.0)\n');

    await expect(getPasskeyAutoFillStatus()).resolves.toEqual({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    });
  });

  it('returns disabled status when defaults read fails and PluginKit has no enabled Rose row', async () => {
    execFileFails('defaults', new Error('missing default'));
    execFileSucceeds('pluginkit', '     com.rose.desktop.PasskeyProvider(1.0)\n');

    await expect(getPasskeyAutoFillStatus()).resolves.toEqual({
      success: true,
      enabled: false,
      credentialExchangeEnabled: false,
    });
  });

  it('opens the helper when the developer gate is already enabled', async () => {
    execFileSucceeds('defaults', '1\n');
    spawnHelper({ stdout: '{"success":true,"enabled":true,"openedSettings":true}' });

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: true,
      enabled: true,
      openedSettings: true,
      credentialExchangeEnabled: true,
    });
  });

  it('enables the developer gate before opening the helper', async () => {
    execFileFails('defaults', new Error('missing default'));
    execFileSucceeds('defaults', '');
    execFileSucceeds('killall', '');
    execFileSucceeds('defaults', 'YES\n');
    spawnHelper({ stdout: '{"success":true,"enabled":true}' });

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    });
  });

  it('falls back to PluginKit status when helper succeeds but reports disabled', async () => {
    execFileSucceeds('defaults', 'YES\n');
    spawnHelper({ stdout: '{"success":true,"enabled":false}' });
    execFileSucceeds('pluginkit', '+    com.rose.desktop.PasskeyProvider(1.0)\n');

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    });
  });

  it('surfaces helper stderr when the helper exits nonzero', async () => {
    execFileSucceeds('defaults', 'YES\n');
    spawnHelper({ stderr: 'settings failed', code: 2 });

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: false,
      message: 'settings failed',
      credentialExchangeEnabled: true,
    });
  });

  it('surfaces invalid helper JSON', async () => {
    execFileSucceeds('defaults', 'YES\n');
    spawnHelper({ stdout: 'not-json' });

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: false,
      message: 'Invalid permission helper output: not-json',
      credentialExchangeEnabled: true,
    });
  });

  it('returns a failure when the developer gate cannot be written', async () => {
    execFileFails('defaults', new Error('missing default'));
    execFileFails('defaults', new Error('defaults write denied'));

    await expect(requestPasskeyAutoFillPermission()).resolves.toEqual({
      success: false,
      credentialExchangeEnabled: false,
      message: 'defaults write denied',
    });
  });

  it('resolves false when PluginKit command fails', async () => {
    execFileFails('pluginkit', new Error('pluginkit unavailable'));

    await expect(isRoseProviderEnabled()).resolves.toBe(false);
  });
});
