/**
 * Multi-file `display` content: sites, 3D models and PDFs, served from the
 * sandboxed usercontent origin with relative paths working.
 *
 *   files (path → bytes) + entry ─► buildDisplayBundle
 *     │  model / pdf entry  → + generated index.html viewer (assets/display/*.html)
 *     │  .js / .mjs entry   → + generated index.html that runs it as a module
 *     │                       (three.js import map; assets/display/script-viewer.html)
 *     │  caps: ≤ DISPLAY_BUNDLE_MAX_FILES files, ≤ DISPLAY_BUNDLE_MAX_BYTES total,
 *     │        ≤ DISPLAY_MAX_FILE_BYTES per file, safe relative paths only
 *     ▼
 *   storeDisplayBundle (content-addressed, write-once):
 *     <owner>/display/blobs/<file sha256>          every file, deduped across bundles
 *     <owner>/display/bundles/<bundleHash>.json    canonical manifest, written LAST
 *     bundleHash = sha256(canonical manifest bytes)
 *   GET /usercontent/display/<agentId>/<bundleHash>/<path>
 *     owner(agentId) → manifest (verified against its hash, LRU) → blob bytes
 *
 * collectDisplayBundleFiles follows relative references (HTML attributes, CSS
 * url()/@import, JS imports/fetch/new URL, glTF buffers/images, OBJ mtllib and
 * MTL maps) from the entry (a page, model or script) through a caller-supplied resolver: local files
 * for the `rose` CLI (rose.cjs mirrors this walk) and the agent tree's files
 * for Rose agents.
 *
 * 10k-agent behaviour: per-call work is bounded by the caps; serving is one
 * cached manifest read + one blob read per request, immutable and CDN-cacheable.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, posix, resolve } from 'path';
import { isSafeUserUiPath, userUiContentType } from '../userUi/manifest';
import { DisplayFetchError, getDisplayObject, putDisplayObject } from './media';

export const DISPLAY_BUNDLE_MAX_FILES = 500;
export const DISPLAY_BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
export const DISPLAY_BUNDLE_FILE_MAX_BYTES = 20 * 1024 * 1024;
/** Generated viewer page of a model / PDF bundle. */
export const DISPLAY_VIEWER_ENTRY = 'index.html';

export type DisplayBundleKind = 'bundle' | 'model' | 'pdf' | 'script';

export interface DisplayBundleManifest {
  v: 1;
  kind: DisplayBundleKind;
  /** Path the UI frames: the site's page, or the generated viewer. */
  entry: string;
  /** The displayed source file (model / PDF / script) or the site's entry page. */
  source: string;
  files: Record<string, { sha256: string; size: number }>;
}

export interface BuiltDisplayBundle {
  hash: string;
  manifest: DisplayBundleManifest;
  manifestBytes: Buffer;
  blobs: Map<string, Buffer>;
  totalBytes: number;
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const ext = (path: string) => path.slice(path.lastIndexOf('.') + 1).toLowerCase();

export const DISPLAY_MODEL_EXTENSIONS = new Set(['glb', 'gltf', 'obj', 'stl', 'usdz']);
export const DISPLAY_SCRIPT_EXTENSIONS = new Set(['js', 'mjs']);

const DISPLAY_CONTENT_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  stl: 'model/stl',
  usdz: 'model/vnd.usdz+zip',
  bin: 'application/octet-stream',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  ktx2: 'image/ktx2',
  hdr: 'application/octet-stream',
};

export function displayContentType(path: string): string {
  return DISPLAY_CONTENT_TYPES[ext(path)] ?? userUiContentType(path);
}

export const displayBlobKey = (ownerId: string, sha: string) => `${ownerId}/display/blobs/${sha}`;
export const displayBundleKey = (ownerId: string, hash: string) =>
  `${ownerId}/display/bundles/${hash}.json`;

// ── viewer templates (src/assets/display, copied to dist/assets by the build) ──

function displayAssetsDir(): string {
  const candidates = [
    resolve(__dirname, '../../assets/display'),
    resolve(__dirname, '../../../src/assets/display'),
  ];
  const found = candidates.find((dir) => existsSync(join(dir, 'model-viewer.html')));
  if (!found)
    throw new Error(`display viewer assets not found (looked in ${candidates.join(', ')})`);
  return found;
}

const templates = new Map<string, string>();
function template(name: string): string {
  let text = templates.get(name);
  if (text === undefined) {
    text = readFileSync(join(displayAssetsDir(), name), 'utf8');
    templates.set(name, text);
  }
  return text;
}

/** JSON safe inside <script type="application/json"> (no `</script>` break-out). */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The built-in three.js viewer page for `src` (orbit controls, auto-framing). */
export function modelViewerHtml(src: string): Buffer {
  const config = { src, format: ext(src), title: posix.basename(src) };
  return Buffer.from(template('model-viewer.html').replace('__ROSE_CONFIG__', scriptJson(config)));
}

/** The page that runs script `src` as an ES module (three.js import map, full-bleed body). */
export function scriptViewerHtml(src: string): Buffer {
  const config = { src, title: posix.basename(src) };
  return Buffer.from(template('script-viewer.html').replace('__ROSE_CONFIG__', scriptJson(config)));
}

/** The built-in pdf.js viewer page for `src` (works inside the sandboxed frame). */
export function pdfViewerHtml(src: string): Buffer {
  const config = { src, title: posix.basename(src) };
  return Buffer.from(template('pdf-viewer.html').replace('__ROSE_CONFIG__', scriptJson(config)));
}

// ── build + validate ──

/**
 * Validate files + entry and produce the content-addressed bundle. `source`
 * is the entry file the caller asked for; a model / PDF / script source gets
 * the generated viewer at DISPLAY_VIEWER_ENTRY. Throws DisplayFetchError (400).
 */
export function buildDisplayBundle(
  source: string,
  files: Map<string, Buffer>,
  kind: DisplayBundleKind
): BuiltDisplayBundle {
  const errors: string[] = [];
  if (!files.has(source)) errors.push(`entry ${source.slice(0, 200)} is not one of the files`);
  const all = new Map(files);
  if (kind !== 'bundle') {
    if (all.has(DISPLAY_VIEWER_ENTRY)) {
      errors.push(
        `a ${kind} bundle cannot contain ${DISPLAY_VIEWER_ENTRY} (display the page instead)`
      );
    }
    const viewer = { model: modelViewerHtml, pdf: pdfViewerHtml, script: scriptViewerHtml }[kind];
    all.set(DISPLAY_VIEWER_ENTRY, viewer(source));
  }
  if (all.size > DISPLAY_BUNDLE_MAX_FILES) {
    errors.push(`bundle has ${all.size} files (max ${DISPLAY_BUNDLE_MAX_FILES})`);
  }
  let totalBytes = 0;
  const entries: [string, { sha256: string; size: number }][] = [];
  const blobs = new Map<string, Buffer>();
  for (const [path, bytes] of [...all.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isSafeUserUiPath(path)) {
      errors.push(`invalid path "${path.slice(0, 200)}" (relative, no "..", no dot-segments)`);
      continue;
    }
    if (bytes.length > DISPLAY_BUNDLE_FILE_MAX_BYTES) {
      errors.push(`${path} is larger than ${DISPLAY_BUNDLE_FILE_MAX_BYTES / 1024 / 1024} MB`);
    }
    totalBytes += bytes.length;
    const sha = sha256(bytes);
    blobs.set(sha, bytes);
    entries.push([path, { sha256: sha, size: bytes.length }]);
  }
  if (totalBytes > DISPLAY_BUNDLE_MAX_BYTES) {
    errors.push(`bundle is larger than ${DISPLAY_BUNDLE_MAX_BYTES / 1024 / 1024} MB`);
  }
  if (errors.length > 0) throw new DisplayFetchError(errors.join('; '));
  const manifest: DisplayBundleManifest = {
    v: 1,
    kind,
    entry: kind === 'bundle' ? source : DISPLAY_VIEWER_ENTRY,
    source,
    files: Object.fromEntries(entries),
  };
  // Key order is fixed by construction and files are path-sorted: canonical bytes.
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  return { hash: sha256(manifestBytes), manifest, manifestBytes, blobs, totalBytes };
}

const STORE_CONCURRENCY = 8;

/** Blobs first, manifest last: a stored manifest never points at a missing blob. */
export async function storeDisplayBundle(ownerId: string, bundle: BuiltDisplayBundle) {
  const blobs = [...bundle.blobs.entries()];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(STORE_CONCURRENCY, blobs.length) }, async () => {
      while (next < blobs.length) {
        const [sha, bytes] = blobs[next++];
        await putDisplayObject(displayBlobKey(ownerId, sha), bytes, 'application/octet-stream');
      }
    })
  );
  await putDisplayObject(
    displayBundleKey(ownerId, bundle.hash),
    bundle.manifestBytes,
    'application/json'
  );
}

// ── read (usercontent) ──

const MANIFEST_CACHE_MAX = 1000;
const manifestCache = new Map<string, DisplayBundleManifest>();

async function readManifest(ownerId: string, hash: string): Promise<DisplayBundleManifest | null> {
  const key = `${ownerId}/${hash}`;
  const hit = manifestCache.get(key);
  if (hit) return hit;
  const bytes = await getDisplayObject(displayBundleKey(ownerId, hash));
  if (!bytes || sha256(bytes) !== hash) return null;
  const manifest = JSON.parse(bytes.toString('utf8')) as DisplayBundleManifest;
  if (manifestCache.size >= MANIFEST_CACHE_MAX) {
    manifestCache.delete(manifestCache.keys().next().value as string);
  }
  manifestCache.set(key, manifest);
  return manifest;
}

/** One file of a stored bundle; null when the bundle or path does not exist. */
export async function readDisplayBundleFile(
  ownerId: string,
  hash: string,
  path: string
): Promise<{ content: Buffer; contentType: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(hash) || !isSafeUserUiPath(path)) return null;
  const manifest = await readManifest(ownerId, hash);
  const file = manifest ? Object.hasOwn(manifest.files, path) && manifest.files[path] : null;
  if (!file) return null;
  const content = await getDisplayObject(displayBlobKey(ownerId, file.sha256));
  return content ? { content, contentType: displayContentType(path) } : null;
}

/**
 * The files a stored bundle was built from (its generated viewer excluded), so
 * displaying it again by name rebuilds the identical bundle (same hash).
 */
export async function readDisplayBundleSources(
  ownerId: string,
  hash: string
): Promise<{ kind: DisplayBundleKind; source: string; files: Map<string, Buffer> } | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const manifest = await readManifest(ownerId, hash);
  if (!manifest) return null;
  const files = new Map<string, Buffer>();
  for (const [path, file] of Object.entries(manifest.files)) {
    if (manifest.kind !== 'bundle' && path === DISPLAY_VIEWER_ENTRY) continue;
    const bytes = await getDisplayObject(displayBlobKey(ownerId, file.sha256));
    if (!bytes) return null;
    files.set(path, bytes);
  }
  return { kind: manifest.kind, source: manifest.source, files };
}

// ── relative references ──

const SCANNABLE = new Set(['html', 'htm', 'css', 'js', 'mjs', 'gltf', 'obj', 'mtl']);
const ATTR_RE = /\b(?:src|href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const SRCSET_RE = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]+))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const JS_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bfetch\s*\(\s*|\bnew\s+URL\s*\(\s*|\bnew\s+(?:Shared)?Worker\s*\(\s*)(?:"([^"\n]*)"|'([^'\n]*)'|`([^`$\n]*)`)/g;

function matches(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const value = m.slice(1).find((group) => group !== undefined);
    if (value) out.push(value);
  }
  return out;
}

function gltfRefs(text: string): string[] {
  try {
    const json = JSON.parse(text) as {
      buffers?: { uri?: unknown }[];
      images?: { uri?: unknown }[];
    };
    return [...(json.buffers ?? []), ...(json.images ?? [])]
      .map((entry) => entry?.uri)
      .filter((uri): uri is string => typeof uri === 'string');
  } catch {
    return [];
  }
}

/** Raw references a file makes to other files (any form; filtered by the caller). */
function rawRefs(path: string, bytes: Buffer): string[] {
  const kind = ext(path);
  const text = bytes.toString('utf8');
  if (kind === 'gltf') return gltfRefs(text);
  if (kind === 'obj') return matches(/^\s*mtllib\s+(.+?)\s*$/gm, text);
  if (kind === 'mtl')
    return matches(/^\s*(?:map_\w+|bump|disp|decal|refl)\s+(?:-\S+\s+\S+\s+)*(\S+)\s*$/gm, text);
  if (kind === 'css') return [...matches(CSS_URL_RE, text), ...matches(CSS_IMPORT_RE, text)];
  if (kind === 'js' || kind === 'mjs') return matches(JS_RE, text);
  const srcset = matches(SRCSET_RE, text).flatMap((value) =>
    value.split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '')
  );
  return [
    ...matches(ATTR_RE, text),
    ...srcset,
    ...matches(CSS_URL_RE, text),
    ...matches(CSS_IMPORT_RE, text),
    ...matches(JS_RE, text),
  ];
}

/**
 * Bundle-relative paths `path` references: no scheme, protocol-relative,
 * root-absolute, fragment-only or escaping references; query/hash stripped.
 */
export function displayRelativeRefs(path: string, bytes: Buffer): string[] {
  const dir = posix.dirname(path);
  const out = new Set<string>();
  for (const raw of rawRefs(path, bytes)) {
    const value = raw.trim().replace(/[?#].*$/, '');
    if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      continue;
    }
    // Bare module specifiers ("three") are import-map names, not files.
    const isPathLike = /^\.\.?\//.test(decoded) || decoded.includes('/') || /\.\w+$/.test(decoded);
    if (!isPathLike) continue;
    const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, decoded));
    if (joined.startsWith('..') || joined === '.' || joined === '') continue;
    out.add(joined);
  }
  out.delete(path);
  return [...out];
}

/**
 * Entry + every file it transitively references that `resolveFile` finds.
 * Missing references are skipped (the page may build them at runtime). Caps
 * apply while walking, so an oversized tree fails before it is all read.
 */
export async function collectDisplayBundleFiles(
  entry: string,
  entryBytes: Buffer,
  resolveFile: (path: string) => Promise<Buffer | null>
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>([[entry, entryBytes]]);
  const tried = new Set<string>([entry]);
  const queue = [entry];
  let total = entryBytes.length;
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (!SCANNABLE.has(ext(path))) continue;
    for (const ref of displayRelativeRefs(path, files.get(path) as Buffer)) {
      if (tried.has(ref)) continue;
      tried.add(ref);
      if (tried.size > DISPLAY_BUNDLE_MAX_FILES * 2) {
        throw new DisplayFetchError(`${entry} references too many files`);
      }
      const bytes = await resolveFile(ref);
      if (bytes === null) continue;
      files.set(ref, bytes);
      total += bytes.length;
      if (files.size > DISPLAY_BUNDLE_MAX_FILES) {
        throw new DisplayFetchError(`bundle has more than ${DISPLAY_BUNDLE_MAX_FILES} files`);
      }
      if (total > DISPLAY_BUNDLE_MAX_BYTES) {
        throw new DisplayFetchError(
          `bundle is larger than ${DISPLAY_BUNDLE_MAX_BYTES / 1024 / 1024} MB`
        );
      }
      queue.push(ref);
    }
  }
  return files;
}
