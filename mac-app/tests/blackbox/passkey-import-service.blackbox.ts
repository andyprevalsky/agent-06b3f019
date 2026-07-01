import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const uploadState = vi.hoisted(() => ({
  uploadPasskeys: vi.fn(async () => ({ success: true })),
  uploadPasswords: vi.fn(async () => ({ success: true })),
  encryptPasswordToEnvelope: vi.fn(async (password: string) => `encrypted:${password}`),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(() => '/Applications/Rose.app/Contents/Resources/app.asar'),
  },
}));

vi.mock('../../main/domains/passkey-enroll/repo', () => ({
  uploadPasskeys: uploadState.uploadPasskeys,
}));

vi.mock('../../main/domains/browser-state-sync/service-simple-uploads', () => ({
  uploadPasswords: uploadState.uploadPasswords,
}));

vi.mock('../../main/domains/browser-password-reader/service', () => ({
  encryptPasswordToEnvelope: uploadState.encryptPasswordToEnvelope,
}));

const { importPasskeysFromToken, __passkeyImportServiceTest } =
  await import('../../main/domains/passkey-import/service');

describe('passkey import service', () => {
  beforeEach(() => {
    uploadState.uploadPasskeys.mockResolvedValue({ success: true });
    uploadState.uploadPasswords.mockResolvedValue({ success: true });
    uploadState.encryptPasswordToEnvelope.mockImplementation(async (password: string) => {
      return `encrypted:${password}`;
    });
  });

  afterEach(() => {
    uploadState.uploadPasskeys.mockClear();
    uploadState.uploadPasswords.mockClear();
    uploadState.encryptPasswordToEnvelope.mockClear();
    __passkeyImportServiceTest.setNativeImporterForTest(null);
  });

  it('imports credentials from the in-process native bridge response', async () => {
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [
        {
          rpId: 'example.com',
          credentialId: 'credential',
          privateKey: 'private-key',
          userHandle: 'user-handle',
          userName: 'andy',
          signCount: 0,
        },
      ],
      passwords: [
        {
          title: 'Example',
          url: 'https://example.com/login',
          userName: 'andy',
          password: 'secret',
        },
      ],
    }));

    const result = await importPasskeysFromToken(
      '123e4567-e89b-12d3-a456-426614174000',
      'access-token'
    );

    expect(result).toEqual({
      success: true,
      count: 2,
      passkeyCount: 1,
      passwordCount: 1,
      message: undefined,
    });
    expect(uploadState.uploadPasskeys).toHaveBeenCalledWith(
      {
        passkeys: [
          expect.objectContaining({
            rpId: 'example.com',
            credentialId: 'credential',
            privateKey: 'private-key',
            browserSource: 'apple_passwords',
          }),
        ],
      },
      'access-token'
    );
    expect(uploadState.uploadPasswords).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          origin: 'https://example.com',
          username: 'andy',
          encryptedPassword: 'encrypted:secret',
          browserSource: 'apple_passwords',
        }),
      ],
      'access-token'
    );
  });

  it('returns a connected empty-transfer result without uploading when the helper has no credentials', async () => {
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [],
      passwords: [],
    }));

    const result = await importPasskeysFromToken(
      '123e4567-e89b-12d3-a456-426614174000',
      'access-token'
    );

    expect(result).toEqual({
      success: true,
      count: 0,
      passkeyCount: 0,
      passwordCount: 0,
      message: 'No credentials in the transfer',
    });
    expect(uploadState.uploadPasskeys).not.toHaveBeenCalled();
    expect(uploadState.uploadPasswords).not.toHaveBeenCalled();
  });

  it('defaults optional passkey fields before upload', async () => {
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [
        {
          rpId: 'example.com',
          credentialId: 'credential',
          privateKey: 'private-key',
          userHandle: '',
          userName: 'andy',
          signCount: undefined as unknown as number,
        },
      ],
      passwords: [],
    }));

    await importPasskeysFromToken('123e4567-e89b-12d3-a456-426614174000', 'access-token');

    expect(uploadState.uploadPasskeys).toHaveBeenCalledWith(
      {
        passkeys: [
          expect.objectContaining({
            userHandle: null,
            signCount: 0,
            origin: 'https://example.com',
            browserSource: 'apple_passwords',
          }),
        ],
      },
      'access-token'
    );
    expect(uploadState.uploadPasswords).not.toHaveBeenCalled();
  });

  it('skips blank password rows and keeps malformed URLs as their raw origin', async () => {
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [],
      passwords: [
        {
          title: 'Blank password',
          url: 'https://blank.example/login',
          userName: 'andy',
          password: '',
        },
        {
          title: 'Blank URL',
          url: '',
          userName: 'andy',
          password: 'secret',
        },
        {
          title: 'Malformed',
          url: 'not a url',
          userName: 'andy',
          password: 'secret',
        },
      ],
    }));

    const result = await importPasskeysFromToken(
      '123e4567-e89b-12d3-a456-426614174000',
      'access-token'
    );

    expect(result).toEqual({
      success: true,
      count: 1,
      passkeyCount: 0,
      passwordCount: 1,
      message: undefined,
    });
    expect(uploadState.uploadPasswords).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          origin: 'not a url',
          username: 'andy',
          encryptedPassword: 'encrypted:secret',
          browserSource: 'apple_passwords',
        }),
      ],
      'access-token'
    );
  });

  it('surfaces password upload failures after native import succeeds', async () => {
    uploadState.uploadPasswords.mockResolvedValue({
      success: false,
      message: 'upload route rejected the batch',
    });
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [],
      passwords: [
        {
          title: 'Example',
          url: 'https://example.com/login',
          userName: 'andy',
          password: 'secret',
        },
      ],
    }));

    const result = await importPasskeysFromToken(
      '123e4567-e89b-12d3-a456-426614174000',
      'access-token'
    );

    expect(result).toEqual({
      success: false,
      message: 'upload route rejected the batch',
    });
  });

  it('uses the default password upload failure message when the upload response has none', async () => {
    uploadState.uploadPasswords.mockResolvedValue({ success: false });
    __passkeyImportServiceTest.setNativeImporterForTest(() => ({
      passkeys: [],
      passwords: [
        {
          title: 'Example',
          url: 'https://example.com/login',
          userName: 'andy',
          password: 'secret',
        },
      ],
    }));

    const result = await importPasskeysFromToken(
      '123e4567-e89b-12d3-a456-426614174000',
      'access-token'
    );

    expect(result).toEqual({
      success: false,
      message: 'Password upload failed',
    });
  });

  it('normalizes non-Error native importer failures', async () => {
    __passkeyImportServiceTest.setNativeImporterForTest(() => {
      throw 'native bridge unavailable';
    });

    await expect(
      importPasskeysFromToken('123e4567-e89b-12d3-a456-426614174000', 'access-token')
    ).resolves.toEqual({
      success: false,
      message: 'native bridge unavailable',
    });
  });

  it('surfaces native AuthenticationServices authorization errors with domain and code', () => {
    expect(() =>
      __passkeyImportServiceTest.parseNativeImportResponse(
        JSON.stringify({
          success: false,
          message:
            'Error Domain=com.apple.AuthenticationServices.AuthorizationError Code=1004 "(null)"',
          domain: 'com.apple.AuthenticationServices.AuthorizationError',
          code: 1004,
        })
      )
    ).toThrow(
      'Error Domain=com.apple.AuthenticationServices.AuthorizationError Code=1004 "(null)" domain=com.apple.AuthenticationServices.AuthorizationError code=1004'
    );
  });

  it('parses legacy native array payloads as passkeys', () => {
    expect(
      __passkeyImportServiceTest.parseNativeImportResponse(
        JSON.stringify({
          success: true,
          payload: [
            {
              rpId: 'example.com',
              credentialId: 'credential',
              privateKey: 'private-key',
              userHandle: 'user-handle',
              userName: 'andy',
              signCount: 1,
            },
          ],
        })
      )
    ).toEqual({
      passkeys: [
        expect.objectContaining({
          rpId: 'example.com',
          credentialId: 'credential',
        }),
      ],
      passwords: [],
    });
  });

  it('treats malformed successful native payloads as an empty transfer', () => {
    expect(
      __passkeyImportServiceTest.parseNativeImportResponse(
        JSON.stringify({
          success: true,
          payload: 'not credentials',
        })
      )
    ).toEqual({
      passkeys: [],
      passwords: [],
    });
  });

  it('treats non-array native credential fields as empty lists', () => {
    expect(
      __passkeyImportServiceTest.parseNativeImportResponse(
        JSON.stringify({
          success: true,
          payload: {
            passkeys: { rpId: 'example.com' },
            passwords: { url: 'https://example.com' },
          },
        })
      )
    ).toEqual({
      passkeys: [],
      passwords: [],
    });
  });

  it('rejects non-object native responses', () => {
    expect(() =>
      __passkeyImportServiceTest.parseNativeImportResponse(JSON.stringify('not an object'))
    ).toThrow('native import returned non-object JSON');
  });

  it('uses the default native failure message when the bridge omits details', () => {
    expect(() =>
      __passkeyImportServiceTest.parseNativeImportResponse(
        JSON.stringify({
          success: false,
        })
      )
    ).toThrow('native import failed');
  });
});
