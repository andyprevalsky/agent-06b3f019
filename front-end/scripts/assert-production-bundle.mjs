import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(projectRoot, 'dist', 'assets');
const devToolMarkers = ['react-grab.com', 'data-react-grab', 'React Grab v'];
const offenders = [];

for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const source = await readFile(path.join(assetsDir, entry.name), 'utf8');
  if (devToolMarkers.some((marker) => source.includes(marker))) offenders.push(entry.name);
}

if (offenders.length > 0) {
  throw new Error(
    `Production bundle contains the React Grab development runtime: ${offenders.join(', ')}`,
  );
}

process.stdout.write('Production bundle excludes React Grab development runtime\n');
