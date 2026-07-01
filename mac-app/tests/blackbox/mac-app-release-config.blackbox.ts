/**
 * Blackbox guardrails for packaged Mac app release config.
 *
 * Release-critical state:
 *   package.json -> electron-builder -> packaged Info.plist / Electron runtime
 *   VITE_BACKEND_API_URL -> main + renderer config -> backend fetch URLs
 *
 * The packaged app must not claim browser URL schemes and must not fall back to
 * localhost for production backend calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveBackendUrl as resolveElectronAppBackendUrl } from '../../ui/features/electron-app/config';
import { resolveBackendUrl as resolveOnboardingBackendUrl } from '../../ui/features/onboarding/config';

const ROOT = path.resolve(__dirname, '../..');

function readPackageJson(): {
  engines: Record<string, string>;
  devDependencies: Record<string, string>;
  build: { protocols?: { schemes?: string[] } };
} {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

describe('mac app release config', () => {
  it('stays on the Electron 31 line until native dependencies are upgraded deliberately', () => {
    const pkg = readPackageJson();
    expect(pkg.devDependencies.electron).toBe('^31.0.0');
  });

  it('pins Node to the Electron 31 development version', () => {
    expect(readPackageJson().engines.node).toBe('20.10.0');
  });

  it('registers only the Rose custom URL scheme', () => {
    const schemes = readPackageJson().build.protocols?.schemes;
    expect(schemes).toEqual(['roselabs']);
  });

  it('main-process backend URL resolver fails packaged builds without a backend URL', async () => {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: {
        isPackaged: false,
      },
    }));
    process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
    process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';

    const { resolveApiUrl } = await import('../../main/base/config');
    expect(resolveApiUrl(undefined, false)).toBe('http://localhost:3001');
    expect(() => resolveApiUrl('   ', true)).toThrow(/Missing VITE_BACKEND_API_URL/);
    expect(resolveApiUrl('https://api.example.com', true)).toBe('https://api.example.com');
  });

  it('renderer backend URL resolvers fail production builds without a backend URL', () => {
    const resolvers = [resolveElectronAppBackendUrl, resolveOnboardingBackendUrl];

    for (const resolve of resolvers) {
      expect(resolve(undefined, false)).toBe('http://localhost:3001');
      expect(() => resolve('', true)).toThrow(/Missing VITE_BACKEND_API_URL/);
      expect(resolve('https://api.example.com', true)).toBe('https://api.example.com');
    }
  });
});
