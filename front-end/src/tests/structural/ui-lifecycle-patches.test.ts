import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { transformRadixScrollArea } from '../../../scripts/patch-radix-lifecycle.mjs';
import {
  applyLifecyclePatches,
  UI_LIFECYCLE_PATCHES,
  planLifecyclePatches,
  resolveInstalledPackageRoots,
} from '../../../scripts/patch-ui-lifecycle.mjs';

// The owning effect fragment is identical in the published 1.2.16/1.3.0 CJS/ESM files.
const pristine = `const removeUnlinkedScrollListenerRef = React2.useRef(void 0);
        viewport.addEventListener("scroll", handleScroll);
        return () => viewport.removeEventListener("scroll", handleScroll);
      }
    }, [scrollAreaContext.viewport, debounceScrollEnd, onThumbPositionChange]);`;
const radixPatches = UI_LIFECYCLE_PATCHES.filter(
  ({ name }) => name === '@radix-ui/react-scroll-area',
);
const temporary: string[] = [];
const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), 'rose-ui-lifecycle-test-'));
  temporary.push(root);
  mkdirSync(join(root, 'front-end'), { recursive: true });
  return root;
};
function install(root: string, version: string, esm = pristine) {
  const directory = join(root, 'node_modules/@radix-ui/react-scroll-area');
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@radix-ui/react-scroll-area',
      version,
      main: 'dist/index.js',
    }),
  );
  writeFileSync(join(directory, 'dist/index.js'), pristine);
  writeFileSync(join(directory, 'dist/index.mjs'), esm);
  return directory;
}
afterEach(() =>
  temporary.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
);

describe('UI lifecycle package repair', () => {
  it.each(['1.2.16', '1.3.0'])(
    'validates and idempotently repairs both %s entry points',
    (version) => {
      const root = workspace();
      const directory = install(root, version);
      expect(applyLifecyclePatches(radixPatches, [root])).toEqual({ checked: 2, changed: 2 });
      for (const entry of ['index.js', 'index.mjs']) {
        const after = readFileSync(join(directory, 'dist', entry), 'utf8');
        expect(after).toContain('removeUnlinkedScrollListenerRef.current?.();');
        expect(after).toContain('removeUnlinkedScrollListenerRef.current = void 0;');
        expect(transformRadixScrollArea(after, version)).toBe(after);
      }
      expect(applyLifecyclePatches(radixPatches, [root])).toEqual({ checked: 2, changed: 0 });
    },
  );

  it('resolves and repairs frontend-local and hoisted workspace installations', () => {
    const root = workspace();
    const frontend = join(root, 'front-end');
    const hoisted = install(root, '1.3.0');
    expect(resolveInstalledPackageRoots('@radix-ui/react-scroll-area', [frontend, root])).toEqual([
      hoisted,
    ]);
    const local = install(frontend, '1.2.16');
    expect(resolveInstalledPackageRoots('@radix-ui/react-scroll-area', [frontend, root])).toEqual([
      local,
      hoisted,
    ]);
    expect(applyLifecyclePatches(radixPatches, [frontend, root])).toEqual({
      checked: 4,
      changed: 4,
    });
  });

  it('rejects unknown versions or ambiguous sources without writing valid entries first', () => {
    const root = workspace();
    const directory = install(root, '1.3.0', pristine + pristine);
    expect(() => applyLifecyclePatches(radixPatches, [root])).toThrow('Unexpected Radix');
    expect(readFileSync(join(directory, 'dist/index.js'), 'utf8')).toBe(pristine);
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: '@radix-ui/react-scroll-area',
        version: '9.0.0',
        main: 'dist/index.js',
      }),
    );
    expect(() => planLifecyclePatches(radixPatches, [root])).toThrow('Unsupported Radix');
    expect(() => transformRadixScrollArea('upstream source changed', '1.3.0')).toThrow(
      'Unexpected Radix',
    );
    const partial = transformRadixScrollArea(pristine, '1.3.0').replace(
      'const removeUnlinkedScrollListenerRef = React2.useRef(void 0);',
      'const missingOwner = null;',
    );
    expect(() => transformRadixScrollArea(partial, '1.3.0')).toThrow('Unexpected Radix');
    expect(() => resolveInstalledPackageRoots('@missing/ui-dependency', [root])).toThrow(
      'not installed',
    );
  });

  it('prevalidates independently planned package repairs before writing any entry', () => {
    const root = workspace();
    const directory = install(root, '1.3.0');
    const independentlyPlanned = {
      name: '@radix-ui/react-scroll-area',
      plan: () => {
        throw new Error('Unsupported second package source');
      },
    };
    expect(() => applyLifecyclePatches([...radixPatches, independentlyPlanned], [root])).toThrow(
      'Unsupported second package',
    );
    expect(readFileSync(join(directory, 'dist/index.js'), 'utf8')).toBe(pristine);
    const file = join(directory, 'dist/index.js');
    expect(
      applyLifecyclePatches(
        [
          {
            ...independentlyPlanned,
            plan: () => [{ path: file, before: pristine, after: 'owned repair' }],
          },
        ],
        [root],
      ),
    ).toEqual({ checked: 1, changed: 1 });
    expect(readFileSync(file, 'utf8')).toBe('owned repair');
  });

  it('does not let tolerated browser-install failure swallow a patch failure', () => {
    const root = workspace();
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/playwright'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH };
    const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    writeFileSync(join(root, 'scripts/patch-ui-lifecycle.mjs'), 'process.exit(7);');
    expect(spawnSync('bash', ['-c', scripts.postinstall], { cwd: root, env }).status).toBe(7);
    writeFileSync(join(root, 'scripts/patch-ui-lifecycle.mjs'), 'process.exit(0);');
    expect(spawnSync('bash', ['-c', scripts.postinstall], { cwd: root, env }).status).toBe(0);
  });

  it('guards normal build, dev, test and coverage entrypoints', () => {
    const { scripts } = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    for (const hook of [
      'predev',
      'prebuild',
      'prebuild:dev',
      'pretest',
      'pretest:coverage',
      'pretest:coverage:report',
      'pretest:e2e',
    ])
      expect(scripts[hook]).toBe('node scripts/patch-ui-lifecycle.mjs');
    expect(readFileSync(resolve('scripts/run-blackbox-tests.sh'), 'utf8')).toContain(
      'node scripts/patch-ui-lifecycle.mjs',
    );
  });
});
