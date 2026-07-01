import fs from 'fs';
import os from 'os';
import path from 'path';
import packageJson from '../../package.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

async function loadConfig(options: { packaged: boolean; appPath: string }) {
  vi.resetModules();
  vi.doMock('electron', () => ({
    app: {
      isPackaged: options.packaged,
      getAppPath: vi.fn(() => options.appPath),
    },
  }));
  return import('../../main/base/config');
}

describe('blackbox: main config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-config-test-'));
    process.env = { ...originalEnv };
    delete process.env.VITE_BACKEND_API_URL;
    process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
  });

  afterEach(() => {
    vi.doUnmock('electron');
    process.env = { ...originalEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('packaged app loads .env.production from app.asar root and uses its backend URL', async () => {
    fs.writeFileSync(
      path.join(tmpDir, '.env.production'),
      'VITE_BACKEND_API_URL=https://navi-j9a9.onrender.com\n',
      'utf8'
    );

    const { config } = await loadConfig({ packaged: true, appPath: tmpDir });

    expect(config.apiUrl).toBe('https://navi-j9a9.onrender.com');
  });

  it('packaged app fails loudly instead of falling back to localhost when backend URL is missing', async () => {
    await expect(loadConfig({ packaged: true, appPath: tmpDir })).rejects.toThrow(
      'Missing VITE_BACKEND_API_URL'
    );
  });

  it('dev app keeps the localhost default for local run.sh wiring', async () => {
    const { config } = await loadConfig({ packaged: false, appPath: tmpDir });

    expect(config.apiUrl).toBe('http://localhost:3001');
  });

  it('release builds embed the provisioning profile required by passkey entitlements', () => {
    const profilePath = packageJson.build.mac.provisioningProfile;

    expect(profilePath).toBe('build/RoseDesktop.provisionprofile');
    expect(fs.existsSync(path.join(__dirname, '..', '..', profilePath))).toBe(true);
    expect(
      fs.existsSync(path.join(__dirname, '..', '..', 'build', 'PasskeyProvider.provisionprofile'))
    ).toBe(true);
  });
});
