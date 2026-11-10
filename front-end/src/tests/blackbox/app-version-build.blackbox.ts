/**
 * Build-side half of the stale-build reset: vite.config.ts bakes a build id
 * into the bundle and publishes the same id as /version.json; vercel.json
 * serves it uncached and hashed assets immutable. The config is loaded by
 * Vite itself in a child Node process: Vite's esbuild cannot load under jsdom.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONT_END = process.cwd();

/** Loads vite.config.ts the way `vite build` does and runs `script` with the
 * resolved config in scope as `resolved`; returns its printed JSON. */
function withResolvedConfig(command: 'build' | 'serve', script: string): unknown {
  const mode = command === 'build' ? 'production' : 'development';
  const program = `
    import { loadConfigFromFile } from 'vite';
    const loaded = await loadConfigFromFile({ command: '${command}', mode: '${mode}' }, 'vite.config.ts');
    const resolved = loaded.config;
    ${script}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: FRONT_END,
    encoding: 'utf8',
    env: { ...process.env, VERCEL_GIT_COMMIT_SHA: '0123456789abcdef' },
    timeout: 60_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? 'null');
}

describe('build version publishing', () => {
  it('emits /version.json with the same id the production build bakes in', () => {
    const output = withResolvedConfig(
      'build',
      `
      const baked = JSON.parse(resolved.define['import.meta.env.VITE_ROSE_BUILD_ID']);
      const plugin = resolved.plugins.flat().find((p) => p && p.name === 'rose-build-version');
      const emitted = [];
      plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) });
      console.log(JSON.stringify({ baked, apply: plugin.apply, emitted }));
    `,
    ) as { baked: string; apply: string; emitted: { fileName: string; source: string }[] };
    expect(output.baked).toMatch(/^0123456789ab-[0-9a-z]+$/);
    expect(output.apply).toBe('build');
    expect(output.emitted).toEqual([
      {
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ buildId: output.baked })}\n`,
      },
    ]);
  });

  it('bakes no build id into the dev server (version checks stay off)', () => {
    const output = withResolvedConfig(
      'serve',
      `
      console.log(JSON.stringify(resolved.define['import.meta.env.VITE_ROSE_BUILD_ID']));
    `,
    );
    expect(output).toBe('""');
  });

  it('keeps vite.config.ts self-contained: fixtures copy it without its neighbours', () => {
    const config = readFileSync(resolve(FRONT_END, 'vite.config.ts'), 'utf8');
    expect(config).not.toMatch(/from '\.\.?\//);
  });

  it('serves hashed assets as immutable and the version file uncached', () => {
    const vercel = JSON.parse(readFileSync(resolve(FRONT_END, 'vercel.json'), 'utf8')) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
    };
    const header = (source: string) =>
      vercel.headers
        .find((entry) => entry.source === source)
        ?.headers.find((entry) => entry.key === 'Cache-Control')?.value;
    expect(header('/assets/(.*)')).toBe('public, max-age=31536000, immutable');
    expect(header('/version.json')).toBe('no-store');
  });
});
