import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.resolve(projectRoot, process.argv[2] || 'dist', 'assets');
const devToolMarkers = ['react-grab.com', 'data-react-grab', 'React Grab v'];
const offenders = [];
const jsonPayloadHashes = new Set();
const payloadFilesByHash = new Map();

/** Read a generated JavaScript string literal without evaluating bundle code. */
function readStringLiteral(source, start) {
  const quote = source[start];
  const parts = [];
  let segmentStart = start + 1;
  let cursor = segmentStart;

  while (cursor < source.length) {
    const character = source[cursor];
    if (character === quote) {
      parts.push(source.slice(segmentStart, cursor));
      return { value: parts.join(''), end: cursor + 1 };
    }
    if (character !== '\\') {
      cursor++;
      continue;
    }

    parts.push(source.slice(segmentStart, cursor));
    cursor++;
    const escaped = source[cursor++];
    const escapes = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', 0: '\0' };
    if (escaped === 'x' || escaped === 'u') {
      const braced = escaped === 'u' && source[cursor] === '{';
      const end = braced ? source.indexOf('}', cursor + 1) : cursor + (escaped === 'x' ? 2 : 4);
      const digits = source.slice(cursor + (braced ? 1 : 0), end);
      if (end < 0 || !/^[\da-f]+$/i.test(digits)) {
        throw new Error('Invalid Unicode escape in generated JSON string');
      }
      parts.push(String.fromCodePoint(Number.parseInt(digits, 16)));
      cursor = end + (braced ? 1 : 0);
    } else if (escaped === '\r') {
      if (source[cursor] === '\n') cursor++;
    } else if (escaped !== '\n') {
      parts.push(escapes[escaped] ?? escaped);
    }
    segmentStart = cursor;
  }
  throw new Error('Unterminated generated JSON string');
}

function payloadHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

for (const entry of await readdir(assetsDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const source = await readFile(path.join(assetsDir, entry.name), 'utf8');
  if (devToolMarkers.some((marker) => source.includes(marker))) offenders.push(entry.name);
  for (const match of source.matchAll(/JSON\.parse\(\s*(['"])/g)) {
    let payload;
    try {
      const literal = readStringLiteral(source, match.index + match[0].length - 1);
      let closing = literal.end;
      while (/\s/.test(source[closing] ?? '')) closing++;
      if (source[closing] !== ')') continue;
      payload = JSON.parse(literal.value);
    } catch {
      continue;
    }
    if (payload && typeof payload === 'object') {
      const hash = payloadHash(payload);
      jsonPayloadHashes.add(hash);
      const files = payloadFilesByHash.get(hash) ?? new Set();
      files.add(entry.name);
      payloadFilesByHash.set(hash, files);
    }
  }
}

if (offenders.length > 0) {
  throw new Error(
    `Production bundle contains the React Grab development runtime: ${offenders.join(', ')}`,
  );
}

process.stdout.write('Production bundle excludes React Grab development runtime\n');

const animationDir = path.join(projectRoot, 'src', 'lib');
const animationFiles = (await readdir(animationDir))
  .filter((entry) => /^animation-\d+-pixels\.json$/.test(entry))
  .map((entry) => path.join(animationDir, entry));
const asciiDir = path.join(
  projectRoot,
  'src',
  'features',
  'terminal-component-group',
  'components',
);
animationFiles.push(
  path.join(asciiDir, 'ascii-frames.json'),
  path.join(asciiDir, 'ascii-frames-engine.json'),
);
for (const file of animationFiles) {
  const expected = JSON.parse(await readFile(file, 'utf8'));
  if (!jsonPayloadHashes.has(payloadHash(expected))) {
    throw new Error(
      `Production bundle must preserve ${path.basename(file)} as an identical JSON.parse payload`,
    );
  }
}

process.stdout.write('Production animation payloads preserve every frame and metadata value\n');

// STATE MACHINE: manifest entry -> static imports only -> startup assets.
// Dynamic imports retain desktop frames without charging mobile startup for them.
let manifest;
try {
  manifest = JSON.parse(
    await readFile(path.join(assetsDir, '..', '.vite', 'manifest.json'), 'utf8'),
  );
} catch {
  throw new Error('Production startup manifest is required');
}
const startupAssets = new Set();
const visited = new Set();
function visitStaticImport(key) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry?.file) throw new Error(`Production manifest has an unresolved startup entry: ${key}`);
  startupAssets.add(path.basename(entry.file));
  for (const imported of entry.imports ?? []) visitStaticImport(imported);
}
const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
if (entries.length === 0)
  throw new Error('Production startup manifest is required to contain an entry');
entries.forEach(visitStaticImport);
for (const file of animationFiles.filter((file) => /animation-\d+-pixels\.json$/.test(file))) {
  const hash = payloadHash(JSON.parse(await readFile(file, 'utf8')));
  if ([...payloadFilesByHash.get(hash)].some((file) => startupAssets.has(file))) {
    throw new Error(
      `Desktop animation payload must be deferred from app startup: ${path.basename(file)}`,
    );
  }
}
process.stdout.write('Desktop animation payloads are deferred from app startup\n');
