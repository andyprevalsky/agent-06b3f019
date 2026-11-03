/** Verify every installed UI lifecycle repair before builds and tests consume it. */
import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformRadixScrollArea } from './patch-radix-lifecycle.mjs';
import { planAmplitudeLifecyclePatch } from './patch-amplitude-lifecycle.mjs';
import { planReplayLifecyclePatch } from './patch-replay-lifecycle.mjs';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ROOTS = [FRONTEND_ROOT, dirname(FRONTEND_ROOT)];
export const UI_LIFECYCLE_PATCHES = [
  {
    name: '@amplitude/rrweb-record',
    plan: planReplayLifecyclePatch,
  },
  {
    name: '@amplitude/plugin-autocapture-browser',
    plan: planAmplitudeLifecyclePatch,
  },
  {
    name: '@radix-ui/react-scroll-area',
    files: ['dist/index.js', 'dist/index.mjs'],
    transform: transformRadixScrollArea,
  },
];

function contains(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function discoverInstalledPackages(packageNames, roots) {
  const locations = roots.map((root) => realpathSync(resolve(root)));
  if (!locations.length) throw new Error('UI dependency workspace roots are required');
  let workspace = locations[0];
  while (!locations.every((root) => contains(workspace, root))) workspace = dirname(workspace);
  const found = new Map(packageNames.map((name) => [name, new Set()]));
  const pending = [];
  const visited = new Set();
  const realDirectory = (directory) => {
    try {
      const real = realpathSync(directory);
      if (!contains(workspace, real))
        throw new Error(`UI dependency directory is outside the workspace: ${directory}`);
      return statSync(real).isDirectory() ? real : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const enqueue = (directory) => {
    if (!contains(workspace, resolve(directory))) return;
    const real = realDirectory(directory);
    if (real && !visited.has(real)) {
      visited.add(real);
      pending.push(real);
    }
  };
  for (const root of locations) {
    const resolver = createRequire(join(root, 'package.json'));
    for (const name of found.keys())
      for (const lookup of resolver.resolve.paths(name) ?? []) enqueue(lookup);
  }
  // Walk package directories only; never scan dependency source files or follow a cycle.
  for (let index = 0; index < pending.length; index++) {
    const modules = pending[index];
    for (const [name, directories] of found) {
      const directory = realDirectory(join(modules, name));
      if (!directory) continue;
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== name) throw new Error(`Unexpected UI package identity: ${directory}`);
      directories.add(directory);
    }
    for (const entry of readdirSync(modules, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const directory = realDirectory(join(modules, entry.name));
      if (!directory) continue;
      if (entry.name.startsWith('@')) {
        for (const child of readdirSync(directory, { withFileTypes: true })) {
          if (child.isDirectory() || child.isSymbolicLink()) {
            const packageRoot = realDirectory(join(directory, child.name));
            if (packageRoot) enqueue(join(packageRoot, 'node_modules'));
          }
        }
      } else enqueue(join(directory, 'node_modules'));
    }
  }
  for (const [name, directories] of found)
    if (!directories.size) throw new Error(`Required UI dependency is not installed: ${name}`);
  return found;
}

export function resolveInstalledPackageRoots(packageName, roots = DEFAULT_ROOTS) {
  return [...discoverInstalledPackages([packageName], roots).get(packageName)];
}

export function planLifecyclePatches(patches = UI_LIFECYCLE_PATCHES, roots = DEFAULT_ROOTS) {
  const installed = discoverInstalledPackages(
    patches.map(({ name }) => name),
    roots,
  );
  return patches.flatMap(({ name, files, transform, plan }) =>
    [...installed.get(name)].flatMap((packageRoot) => {
      if (plan)
        return plan(packageRoot).map(({ path, before, after }) => ({
          filePath: path,
          before,
          after,
        }));
      const { version } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      return files.map((entry) => {
        const filePath = join(packageRoot, entry);
        const before = readFileSync(filePath, 'utf8');
        return { filePath, before, after: transform(before, version) };
      });
    }),
  );
}

export function applyLifecyclePatches(patches = UI_LIFECYCLE_PATCHES, roots = DEFAULT_ROOTS) {
  // Resolve and validate every entry first, so unknown sources cause no partial repair.
  const plans = planLifecyclePatches(patches, roots);
  let changed = 0;
  for (const { filePath, before, after } of plans) {
    const current = readFileSync(filePath, 'utf8');
    if (current === after) continue;
    if (current !== before)
      throw new Error(`UI dependency changed during patch verification: ${filePath}`);
    const temporary = `${filePath}.rose-lifecycle-${process.pid}.tmp`;
    try {
      writeFileSync(temporary, after, { flag: 'wx', mode: statSync(filePath).mode });
      renameSync(temporary, filePath);
      changed++;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  return { checked: plans.length, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { checked, changed } = applyLifecyclePatches();
  process.stdout.write(`UI lifecycle patches verified: ${checked} entries, ${changed} updated\n`);
}
