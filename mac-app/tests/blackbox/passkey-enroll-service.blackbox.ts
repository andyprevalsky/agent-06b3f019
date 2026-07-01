import type { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  close: vi.fn(),
  executeJavaScript: vi.fn(),
  isDestroyed: vi.fn(() => false),
  loadURL: vi.fn(),
  options: null as unknown,
  uploadPasskeys: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../main/domains/passkey-enroll/config', () => ({
  APPLE_PASSWORDS_PASSKEY_SOURCE: 'apple_passwords',
  ENROLL_TIMEOUT_MS: 5_000,
  ENROLL_WINDOW: {
    height: 820,
    title: 'Add agent passkey',
    width: 1100,
  },
  PASSKEY_BROWSER_SOURCE: 'cdp_virtual',
  PASSKEY_UPLOAD_ENDPOINT: '/api/integrations/passkeys/upload',
  POLL_INTERVAL_MS: 1,
}));

vi.mock('electron', async () => {
  const { EventEmitter: NodeEventEmitter } =
    await vi.importActual<typeof import('events')>('events');

  class BrowserWindow extends NodeEventEmitter {
    webContents: EventEmitter & {
      executeJavaScript: typeof state.executeJavaScript;
    };

    constructor(options: unknown) {
      super();
      state.options = options;
      this.webContents = new NodeEventEmitter() as EventEmitter & {
        executeJavaScript: typeof state.executeJavaScript;
      };
      this.webContents.executeJavaScript = state.executeJavaScript;
    }

    close() {
      state.close();
    }

    isDestroyed() {
      return state.isDestroyed();
    }

    loadURL(url: string) {
      return state.loadURL.call(this, url);
    }
  }

  return { BrowserWindow };
});

vi.mock('../../main/domains/passkey-enroll/repo', () => ({
  uploadPasskeys: state.uploadPasskeys,
}));

const { enrollPasskey, toUploadEntry } = await import('../../main/domains/passkey-enroll/service');

describe('passkey enroll service', () => {
  beforeEach(() => {
    state.close.mockClear();
    state.executeJavaScript.mockReset();
    state.isDestroyed.mockReset();
    state.isDestroyed.mockReturnValue(false);
    state.loadURL.mockReset();
    state.options = null;
    state.uploadPasskeys.mockClear();
    state.uploadPasskeys.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps page captures into upload entries with stable defaults', () => {
    expect(
      toUploadEntry({
        credentialId: 'credential',
        privateKey: 'private-key',
        rpId: 'Example.COM',
      })
    ).toEqual({
      browserSource: 'cdp_virtual',
      credentialId: 'credential',
      origin: 'https://example.com',
      privateKey: 'private-key',
      rpId: 'Example.COM',
      signCount: 0,
      userHandle: null,
    });
  });

  it('keeps malformed rpIds lowercased when deriving the upload origin', () => {
    expect(
      toUploadEntry({
        credentialId: 'credential',
        privateKey: 'private-key',
        rpId: 'NOT A HOST',
        signCount: 7,
        userHandle: 'user-handle',
      })
    ).toMatchObject({
      origin: 'https://not a host',
      signCount: 7,
      userHandle: 'user-handle',
    });
  });

  it('opens the enrollment window, captures the generated passkey, uploads it, and closes', async () => {
    state.loadURL.mockImplementation(function (this: EventEmitter & { webContents: EventEmitter }) {
      this.webContents.emit('dom-ready');
      return Promise.resolve();
    });
    state.executeJavaScript.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
      credentialId: 'credential',
      privateKey: 'private-key',
      rpId: 'example.com',
      signCount: 2,
      userHandle: 'user-handle',
    });

    const result = await enrollPasskey({ url: 'https://example.com/security' }, 'access-token');

    expect(result).toEqual({
      success: true,
      rpId: 'example.com',
      credentialId: 'credential',
    });
    expect(state.options).toMatchObject({
      show: true,
      title: 'Add agent passkey',
      webPreferences: {
        contextIsolation: false,
        partition: 'persist:passkey-enroll',
        sandbox: false,
      },
    });
    expect(state.uploadPasskeys).toHaveBeenCalledWith(
      {
        passkeys: [
          expect.objectContaining({
            browserSource: 'cdp_virtual',
            credentialId: 'credential',
            privateKey: 'private-key',
            rpId: 'example.com',
          }),
        ],
      },
      'access-token'
    );
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('reports a user-closed window before capture', async () => {
    state.loadURL.mockImplementation(function (this: EventEmitter & { webContents: EventEmitter }) {
      this.emit('closed');
      this.webContents.emit('dom-ready');
      return Promise.resolve();
    });

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'Window closed before a passkey was added',
    });
    expect(state.uploadPasskeys).not.toHaveBeenCalled();
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('reports a user-closed window when the window closes during polling sleep', async () => {
    state.loadURL.mockImplementation(function (this: EventEmitter) {
      setTimeout(() => this.emit('closed'), 0);
      return Promise.resolve();
    });
    state.executeJavaScript.mockResolvedValue(null);

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'Window closed before a passkey was added',
    });
    expect(state.uploadPasskeys).not.toHaveBeenCalled();
  });

  it('times out when the page never exposes a capture', async () => {
    vi.useFakeTimers();
    state.loadURL.mockResolvedValue(undefined);
    state.executeJavaScript.mockResolvedValue(null);

    const result = enrollPasskey({ url: 'https://example.com/security' }, 'access-token');
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(result).resolves.toEqual({
      success: false,
      message: 'No passkey was added before the timeout',
    });
    expect(state.uploadPasskeys).not.toHaveBeenCalled();
  });

  it('keeps polling when the page capture is incomplete', async () => {
    vi.useFakeTimers();
    state.loadURL.mockResolvedValue(undefined);
    state.executeJavaScript.mockResolvedValue({
      credentialId: 'credential',
      privateKey: '',
      rpId: 'example.com',
    });

    const result = enrollPasskey({ url: 'https://example.com/security' }, 'access-token');
    await vi.advanceTimersByTimeAsync(5_001);

    await expect(result).resolves.toEqual({
      success: false,
      message: 'No passkey was added before the timeout',
    });
    expect(state.uploadPasskeys).not.toHaveBeenCalled();
  });

  it('retries when capture polling races a navigation error', async () => {
    state.loadURL.mockResolvedValue(undefined);
    state.executeJavaScript
      .mockRejectedValueOnce(new Error('mid-navigation'))
      .mockResolvedValueOnce({
        credentialId: 'credential',
        privateKey: 'private-key',
        rpId: 'example.com',
      });

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toMatchObject({
      success: true,
      credentialId: 'credential',
    });
  });

  it('normalizes non-Error upload failures', async () => {
    state.loadURL.mockResolvedValue(undefined);
    state.executeJavaScript.mockResolvedValue({
      credentialId: 'credential',
      privateKey: 'private-key',
      rpId: 'example.com',
    });
    state.uploadPasskeys.mockImplementation(async () => {
      throw 'upload unavailable';
    });

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'upload unavailable',
    });
  });

  it('returns the load failure message and still closes the window', async () => {
    state.loadURL.mockRejectedValue(new Error('navigation failed'));

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'navigation failed',
    });
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it('does not close an already destroyed enrollment window after a failure', async () => {
    state.isDestroyed.mockReturnValue(true);
    state.loadURL.mockRejectedValue(new Error('navigation failed'));

    await expect(
      enrollPasskey({ url: 'https://example.com/security' }, 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'navigation failed',
    });
    expect(state.close).not.toHaveBeenCalled();
  });
});
