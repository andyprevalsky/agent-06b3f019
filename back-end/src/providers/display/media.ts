/**
 * Media helpers for the `display` tool: content-type sniffing, a bounded
 * SSRF-guarded URL fetch, and the object store the displayed bytes live in.
 *
 *   bytes ─► sniffDisplayMediaType ─► image/png | … | video/mp4 | null (rejected)
 *   url   ─► fetchDisplayMedia (http(s) only, public addresses only — checked
 *            again at connect time — ≤ maxBytes, ≤ 5 redirects, timeout)
 *
 * The content type is decided from the bytes, never from a filename or a
 * remote Content-Type header, so an HTML/SVG payload renamed to .png is
 * refused instead of being served from the attachments bucket.
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

/** Recognised image/video type from magic bytes, or null. SVG is deliberately excluded. */
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

export const DISPLAY_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
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
): Promise<{ bytes: Buffer; finalUrl: string }> {
  let url = assertFetchableUrl(rawUrl);
  const signal = AbortSignal.timeout(opts.timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: { Accept: 'image/*,video/*;q=0.9,*/*;q=0.1', 'User-Agent': 'RoseDisplay/1.0' },
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

export async function getDisplayObject(key: string): Promise<Buffer | null> {
  if (!useLocalBackend()) return getStorageObject(key);
  try {
    return await readFile(localPath(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
