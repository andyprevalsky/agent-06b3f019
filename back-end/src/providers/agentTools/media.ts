/**
 * Media helpers for the `display` tool: content-type sniffing, a bounded
 * SSRF-guarded URL fetch, and the object store the displayed bytes live in.
 *
 *   bytes ─► classifyDisplayMedia ─► image/* (incl. image/svg+xml) | video/* | application/pdf |
 *                                    model/* | text/html | text/javascript | null (rejected)
 *   url   ─► fetchDisplayMedia (http(s) only, public addresses only — checked
 *            again at connect time — ≤ maxBytes, ≤ 5 redirects, timeout)
 *
 * Images, videos, PDFs and GLB models are decided from magic bytes, never from
 * a filename or a remote Content-Type header, so an HTML/SVG payload renamed
 * to .png is refused. text/html is accepted only when the caller declared HTML
 * (a .html / .htm name or a text/html response) AND the bytes are UTF-8
 * markup; JavaScript likewise needs a declared .js / .mjs name (or a
 * JavaScript response) AND UTF-8 text that is not markup; text model formats
 * (.gltf JSON, .obj, ASCII .stl) and .usdz need their extension plus a
 * structural check. HTML, scripts and models are only ever served from the
 * sandboxed user-content origin (displayBundle.ts). SVG is an image: UTF-8 text
 * whose root element is <svg> (a standalone .svg, never an HTML page). It is
 * stored as image/svg+xml, rendered only through <img> (scripts never run in an
 * image), and its signed URLs force a download so it is never opened as a page.
 *
 * Storage: Supabase Storage (providers/storage.ts) by default; with
 * DISPLAY_STORAGE_BACKEND=local (+ DISPLAY_STORAGE_LOCAL_DIR) objects go to
 * local disk for hermetic tests.
 */
import { lookup as lookupAtConnection } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { getStorageObject, putStorageObject } from '../storage';

const sig = (bytes: Buffer, offset: number, ...values: number[]) =>
  bytes.length >= offset + values.length && values.every((v, i) => bytes[offset + i] === v);
const ascii = (bytes: Buffer, offset: number, text: string) =>
  bytes.length >= offset + text.length &&
  bytes.subarray(offset, offset + text.length).toString('latin1') === text;

/** Recognised binary image/video type from magic bytes, or null. SVG is text; see looksLikeSvg. */
export function sniffDisplayMediaType(bytes: Buffer): string | null {
  if (sig(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (sig(bytes, 0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return 'image/gif';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp';
  if (ascii(bytes, 0, 'BM') && bytes.length > 26) return 'image/bmp';
  if (sig(bytes, 0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
  if (ascii(bytes, 4, 'ftyp')) {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  return null;
}

const HTML_START =
  /^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html|head|body|div|main|section|svg|canvas|script|style|meta|link|title|h[1-6]|p|table|img|video)\b/i;

/** True when `bytes` are valid UTF-8 text that starts like an HTML document. */
export function looksLikeHtml(bytes: Buffer): boolean {
  if (sniffDisplayMediaType(bytes) !== null) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes('\u0000')) return false;
  return HTML_START.test(text.replace(/^\uFEFF/, '').slice(0, 4096));
}

/** Root element `<svg` after an optional BOM, XML declaration, comments and SVG doctype. */
const SVG_START =
  /^\s*(<\?xml\b[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype\s+svg\b[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg\b/i;
const DECLARED_SVG_NAME = /\.svg$/i;
const DECLARED_SVG_TYPE = /^image\/svg\+xml\b/i;

/** True when `bytes` are UTF-8 text without NULs whose root element is `<svg>`. */
export function looksLikeSvg(bytes: Buffer): boolean {
  if (sniffDisplayMediaType(bytes) !== null) return false;
  const text = utf8(bytes);
  if (text === null || text.includes('\u0000')) return false;
  return SVG_START.test(text.replace(/^\uFEFF/, '').slice(0, 4096));
}

const DECLARED_SCRIPT_NAME = /\.m?js$/i;
const DECLARED_SCRIPT_TYPE = /^(text|application)\/(javascript|ecmascript|x-javascript)\b/i;

/**
 * True when `bytes` are non-empty UTF-8 text without NULs that is not markup (a script).
 * JavaScript never starts with `<`, so any markup opener (`<span>`, not only the HTML_START
 * tags) means the file is renamed markup, not a module.
 */
function looksLikeScript(bytes: Buffer): boolean {
  if (sniffDisplayMediaType(bytes) !== null || looksLikeHtml(bytes)) return false;
  const text = utf8(bytes);
  return (
    text !== null &&
    !text.includes('\u0000') &&
    text.trim().length > 0 &&
    !text.trimStart().startsWith('<')
  );
}

/**
 * Allowed type for one display item, or null. `hint` is the declared name or
 * Content-Type; it can only ever unlock text/html or text/javascript, never
 * relabel binary bytes.
 */
export function classifyDisplayMedia(
  bytes: Buffer,
  hint: { filename?: string; contentType?: string } = {}
): string | null {
  const sniffed = sniffDisplayMediaType(bytes);
  if (sniffed !== null) return sniffed;
  if (ascii(bytes, 0, '%PDF-')) return 'application/pdf';
  if (ascii(bytes, 0, 'glTF')) return 'model/gltf-binary';
  const model = declaredModelType(bytes, hint.filename ?? '');
  if (model !== null) return model;
  const declaredSvg =
    DECLARED_SVG_NAME.test(hint.filename ?? '') || DECLARED_SVG_TYPE.test(hint.contentType ?? '');
  if (declaredSvg) return looksLikeSvg(bytes) ? 'image/svg+xml' : null;
  const declaredHtml =
    /\.html?$/i.test(hint.filename ?? '') || /^text\/html\b/i.test(hint.contentType ?? '');
  if (declaredHtml) return looksLikeHtml(bytes) ? 'text/html' : null;
  if (looksLikeSvg(bytes)) return 'image/svg+xml';
  const declaredScript =
    DECLARED_SCRIPT_NAME.test(hint.filename ?? '') ||
    DECLARED_SCRIPT_TYPE.test(hint.contentType ?? '');
  return declaredScript && looksLikeScript(bytes) ? 'text/javascript' : null;
}

function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Text / zip model formats: the extension names the format, the bytes must match it. */
function declaredModelType(bytes: Buffer, filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'usdz') return sig(bytes, 0, 0x50, 0x4b, 0x03, 0x04) ? 'model/vnd.usdz+zip' : null;
  if (ext === 'stl') {
    const binary = bytes.length >= 84 && 84 + 50 * bytes.readUInt32LE(80) === bytes.length;
    if (binary) return 'model/stl';
    return /^\s*solid\b/.test(utf8(bytes.subarray(0, 512)) ?? '') ? 'model/stl' : null;
  }
  if (ext !== 'gltf' && ext !== 'obj') return null;
  const text = utf8(bytes);
  if (text === null || text.includes('\u0000')) return null;
  if (ext === 'obj') return /^v\s+-?[\d.]/m.test(text) ? 'model/obj' : null;
  try {
    const json = JSON.parse(text) as { asset?: unknown };
    return json !== null && typeof json.asset === 'object' ? 'model/gltf+json' : null;
  } catch {
    return null;
  }
}

/** What the UI renders for a displayed type (the row's `kind`). */
export type DisplayKind = 'page' | 'bundle' | 'model' | 'image' | 'video' | 'pdf';

export function displayKindForType(mimeType: string): DisplayKind {
  if (mimeType === 'text/javascript') return 'bundle';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('model/')) return 'model';
  return 'page';
}

export const DISPLAY_EXTENSIONS: Record<string, string> = {
  'text/html': 'html',
  'text/javascript': 'js',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'model/obj': 'obj',
  'model/stl': 'stl',
  'model/vnd.usdz+zip': 'usdz',
};

export class DisplayFetchError extends Error {}

function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() !== 'unicast';
}

function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new DisplayFetchError(`${raw.slice(0, 200)} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DisplayFetchError(`${url.protocol} URLs are not supported (use http or https)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (isIP(host) !== 0 && isBlockedAddress(host)) ||
    (isIP(host) === 0 && !host.includes('.'))
  ) {
    throw new DisplayFetchError(`${url.hostname} is not a public host`);
  }
  return url;
}

/** Re-check every resolved address while the socket opens (closes DNS rebinding). */
const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  lookupAtConnection(
    hostname,
    { all: true, verbatim: true, family: options.family },
    (error, addresses) => {
      const fail = (err: Error) =>
        options.all === true ? callback(err, []) : callback(err, '', 0);
      if (error) return fail(error);
      const blocked = addresses.find(({ address }) => isBlockedAddress(address));
      if (addresses.length === 0 || blocked !== undefined) {
        return fail(new DisplayFetchError(`${hostname} resolves to a non-public address`));
      }
      if (options.all === true) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    }
  );
};

const publicDispatcher = new Agent({ connect: { lookup: lookupPublicAddress } });
const MAX_REDIRECTS = 5;

async function readCapped(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DisplayFetchError(`${label} is larger than ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DisplayFetchError(`${label} is larger than ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** GET a public http(s) URL with a byte cap; redirects are re-validated hop by hop. */
export async function fetchDisplayMedia(
  rawUrl: string,
  opts: { maxBytes: number; timeoutMs: number }
): Promise<{ bytes: Buffer; finalUrl: string; contentType: string }> {
  let url = assertFetchableUrl(rawUrl);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: {
          Accept: 'image/*,video/*;q=0.9,text/html;q=0.8,*/*;q=0.1',
          'User-Agent': 'RoseDisplay/1.0',
        },
        // Undici's Node fetch extension (not in the DOM RequestInit type).
        ...({ dispatcher: publicDispatcher } as Record<string, unknown>),
      });
    } catch (err) {
      const cause = err instanceof Error ? (err.cause ?? err) : err;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new DisplayFetchError(`could not fetch ${url.hostname}: ${message.slice(0, 200)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new DisplayFetchError(`${url.hostname} redirected without a Location`);
      url = assertFetchableUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new DisplayFetchError(`${url.hostname} returned HTTP ${response.status}`);
    }
    return {
      bytes: await readCapped(response, opts.maxBytes, url.toString().slice(0, 200)),
      finalUrl: url.toString(),
      contentType: response.headers.get('content-type') ?? '',
    };
  }
  throw new DisplayFetchError(`more than ${MAX_REDIRECTS} redirects`);
}

// ── object store ──

function useLocalBackend(): boolean {
  return (process.env.DISPLAY_STORAGE_BACKEND ?? '').trim().toLowerCase() === 'local';
}

function localPath(key: string): string {
  const root = resolve(
    process.env.DISPLAY_STORAGE_LOCAL_DIR || join(process.cwd(), '.context', 'display-storage')
  );
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) throw new Error('display storage key escapes root');
  return full;
}

/** Write once; an existing object at the same (content-addressed) key is success. */
export async function putDisplayObject(key: string, body: Buffer, contentType: string) {
  if (!useLocalBackend()) return putStorageObject(key, body, contentType);
  const full = localPath(key);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, body, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

/**
 * Public URL that serves a displayed HTML page from the sandboxed usercontent
 * origin (same CSP as inline views), so the FE never frames storage directly
 * (hosted storage may serve .html as text/plain). Content-addressed: the page
 * is the write-once `<owner>/display/<sha256>.html` of that agent's owner.
 */
export function displayUsercontentUrl(agentId: string, sha256: string): string {
  return `${displayUsercontentBase()}/usercontent/display/${agentId}/${sha256}.html`;
}

/**
 * Entry URL of a displayed bundle (site, model viewer or PDF viewer): every
 * file is under `/usercontent/display/<agentId>/<bundleHash>/`, so relative
 * paths inside the bundle resolve against its own files.
 */
export function displayBundleUsercontentUrl(agentId: string, hash: string, entry: string): string {
  const path = entry.split('/').map(encodeURIComponent).join('/');
  return `${displayUsercontentBase()}/usercontent/display/${agentId}/${hash}/${path}`;
}

function displayUsercontentBase(): string {
  const base =
    process.env.USERCONTENT_BASE_URL?.trim() ||
    process.env.ROSE_UI_PUBLISH_BASE_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    process.env.RENDER_EXTERNAL_URL?.trim() ||
    `http://localhost:${process.env.PORT || 3001}`;
  return base.replace(/\/+$/, '');
}

export async function getDisplayObject(key: string): Promise<Buffer | null> {
  if (!useLocalBackend()) return getStorageObject(key);
  try {
    return await readFile(localPath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
