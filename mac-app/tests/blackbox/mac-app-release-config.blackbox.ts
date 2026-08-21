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
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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

function sha512Base64(filePath: string): string {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64');
}

describe('mac app release config', () => {
  it('notarizes and staples the app before packaging the updater ZIP and DMG', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '..', '.github', 'workflows', 'release-mac-app.yml'),
      'utf8'
    );
    const notarizeApp = workflow.indexOf('node scripts/notarize.js --app "$APP"');
    const validateApp = workflow.indexOf('xcrun stapler validate "$APP"');
    const packageArtifacts = workflow.indexOf(
      'npx electron-builder --prepackaged "$APP" --mac dmg zip --publish=never'
    );

    expect(notarizeApp, 'the signed .app must be submitted for notarization').toBeGreaterThan(-1);
    expect(validateApp, 'the .app ticket must be stapled and validated').toBeGreaterThan(
      notarizeApp
    );
    expect(
      packageArtifacts,
      'distribution artifacts must be built only after the inner app is stapled'
    ).toBeGreaterThan(validateApp);
  });

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

  it('release feed prep refreshes updater hashes after post-build artifact mutation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-updater-feed-'));
    const dist = path.join(tmp, 'dist');
    fs.mkdirSync(dist);

    const zipPath = path.join(dist, 'Rose-mac.zip');
    const dmgPath = path.join(dist, 'Rose-mac.dmg');
    fs.writeFileSync(zipPath, 'zip-before');
    fs.writeFileSync(dmgPath, 'dmg-before');

    fs.writeFileSync(
      path.join(dist, 'latest-mac.yml'),
      [
        'version: 9.9.9',
        'files:',
        '  - url: Rose-mac.zip',
        `    sha512: ${sha512Base64(zipPath)}`,
        `    size: ${fs.statSync(zipPath).size}`,
        '  - url: Rose-mac.dmg',
        `    sha512: ${sha512Base64(dmgPath)}`,
        `    size: ${fs.statSync(dmgPath).size}`,
        'path: Rose-mac.zip',
        `sha512: ${sha512Base64(zipPath)}`,
        "releaseDate: '2026-07-02T20:45:29.797Z'",
        '',
      ].join('\n')
    );

    fs.appendFileSync(dmgPath, '-stapled');

    const script = path.join(ROOT, 'scripts/prepare-updater-feed.mjs');
    const staleCheck = spawnSync(
      'node',
      [script, '--dist', dist, '--base-url', 'https://cdn.example.com/mac/latest', '--check'],
      { encoding: 'utf8' }
    );
    expect(staleCheck.status).toBe(1);
    expect(staleCheck.stderr).toMatch(/latest-mac\.yml does not match/);

    execFileSync('node', [
      script,
      '--dist',
      dist,
      '--base-url',
      'https://cdn.example.com/mac/latest',
    ]);
    execFileSync('node', [
      script,
      '--dist',
      dist,
      '--base-url',
      'https://cdn.example.com/mac/latest',
      '--check',
    ]);

    const latest = fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8');
    expect(latest).toContain('url: https://cdn.example.com/mac/latest/Rose-mac.zip');
    expect(latest).toContain('url: https://cdn.example.com/mac/latest/Rose-mac.dmg');
    expect(latest).toContain(`sha512: ${sha512Base64(dmgPath)}`);
    expect(latest).toContain(`size: ${fs.statSync(dmgPath).size}`);
    expect(latest).toContain(`sha512: ${sha512Base64(zipPath)}`);
  });

  it('release build writes app-update.yml into the bundle so electron-updater can download', () => {
    // Regression guard: every shipped build was missing
    // Contents/Resources/app-update.yml, so update *checks* worked (setFeedURL
    // in memory) but every *download* died with ENOENT on app-update.yml. The
    // release workflow now runs write-app-update-yml.mjs against the built .app
    // before signing; this exercises that script end-to-end.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      name: string;
      build: { publish?: { provider?: string; url?: string } };
    };
    const publish = pkg.build.publish;
    expect(publish?.provider, 'package.json build.publish.provider must be set').toBeTruthy();
    expect(publish?.url, 'package.json build.publish.url must be set').toBeTruthy();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-app-update-'));
    const appDir = path.join(tmp, 'Rose.app');
    const resources = path.join(appDir, 'Contents', 'Resources');
    fs.mkdirSync(resources, { recursive: true });

    execFileSync('node', [path.join(ROOT, 'scripts/write-app-update-yml.mjs'), '--app', appDir]);

    const ymlPath = path.join(resources, 'app-update.yml');
    expect(fs.existsSync(ymlPath), 'app-update.yml must be written into the bundle').toBe(true);
    const yml = fs.readFileSync(ymlPath, 'utf8');
    expect(yml).toContain(`provider: ${publish!.provider}`);
    expect(yml).toContain(`url: ${publish!.url}`);
    // Cache dir name must match electron-builder's derived <name>-updater so
    // existing users' ~/Library/Caches/<name>-updater keeps being reused.
    expect(yml).toContain(`updaterCacheDirName: ${pkg.name}-updater`);
  });

  it('write-app-update-yml.mjs fails a bundle that is not a mac .app', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rose-app-update-bad-'));
    const result = spawnSync(
      'node',
      [path.join(ROOT, 'scripts/write-app-update-yml.mjs'), '--app', path.join(tmp, 'Nope.app')],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Contents\/Resources/);
  });
});
