import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveInstalledPackageRoots,
  UI_LIFECYCLE_PATCHES,
} from '../../../scripts/patch-ui-lifecycle.mjs';

describe('cloud image frontend install boundary', () => {
  it.each(['Dockerfile.cloudbench', 'Dockerfile.cloudbench-warm'])(
    'runs the real postinstall from the dependency layer of %s',
    (dockerfile) => {
      const root = mkdtempSync(join(tmpdir(), 'rose-image-ui-install-'));
      try {
        const frontend = join(root, 'front-end');
        mkdirSync(frontend);
        const instructions = readFileSync(resolve('..', dockerfile), 'utf8').split(
          'RUN bash /tmp/rose-cloudbench-install-image-deps.sh',
        )[0];
        // Materialize this layer's actual frontend COPY inputs, before the installer runs.
        for (const line of instructions.split('\n')) {
          if (!line.startsWith('COPY ')) continue;
          const tokens = line
            .split(/\s+/)
            .slice(1)
            .filter((token) => !token.startsWith('--'));
          const destination = tokens.at(-1)!;
          for (const source of tokens.slice(0, -1)) {
            if (!source.startsWith('front-end/')) continue;
            const target = join(root, destination.replace(/^\/app\/?/, ''));
            mkdirSync(target.endsWith('/') ? target : resolve(target, '..'), {
              recursive: true,
            });
            cpSync(
              resolve('..', source),
              destination.endsWith('/') ? join(target, basename(source)) : target,
              { recursive: true },
            );
          }
        }
        // Use the real installed manifests and compiled files consumed by the actual guard.
        for (const patch of UI_LIFECYCLE_PATCHES) {
          const source = resolveInstalledPackageRoots(patch.name)[0];
          const target = join(root, 'node_modules', patch.name);
          mkdirSync(target, { recursive: true });
          cpSync(join(source, 'package.json'), join(target, 'package.json'));
          const files = patch.plan
            ? patch.plan(source).map((entry: { path: string }) => entry.path)
            : patch.files.map((entry: string) => join(source, entry));
          for (const file of files) {
            const destination = join(target, relative(source, file));
            mkdirSync(resolve(destination, '..'), { recursive: true });
            cpSync(file, destination);
          }
        }
        const bin = join(root, 'bin');
        mkdirSync(bin);
        writeFileSync(join(bin, 'playwright'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
        const result = spawnSync('npm', ['run', 'postinstall', '--workspaces=false'], {
          cwd: frontend,
          env: { ...process.env, PATH: bin + ':' + process.env.PATH },
          encoding: 'utf8',
        });
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('UI lifecycle patches verified:');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
