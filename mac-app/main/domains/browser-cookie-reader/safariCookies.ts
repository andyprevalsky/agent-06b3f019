import type { CookieData } from './types';

const SAFARI_BINARY_COOKIE_MAGIC = 'cook';
const SAFARI_PAGE_HEADER_SIZE = 8;
const SAFARI_COOKIE_HEADER_SIZE = 56;
const SAFARI_COCOA_TO_CHROME_EPOCH_SECONDS = 12622780800;

function readNullTerminatedString(buffer: Buffer, offset: number, limit: number): string | null {
  if (offset < 0 || offset >= limit) return null;
  const end = buffer.indexOf(0, offset);
  if (end === -1 || end > limit) return null;
  return buffer.toString('utf8', offset, end);
}

function safariTimeToChromeMicros(secondsSince2001: number): number {
  if (!Number.isFinite(secondsSince2001) || secondsSince2001 <= 0) return 0;
  return Math.round((secondsSince2001 + SAFARI_COCOA_TO_CHROME_EPOCH_SECONDS) * 1_000_000);
}

function mapSafariFlags(flags: number): {
  isSecure: boolean;
  isHttpOnly: boolean;
} {
  return {
    isSecure: (flags & 0x01) !== 0,
    isHttpOnly: (flags & 0x04) !== 0,
  };
}

function parseSafariCookie(
  page: Buffer,
  cookieOffset: number,
  pageSize: number
): CookieData | null {
  if (
    cookieOffset < SAFARI_PAGE_HEADER_SIZE ||
    cookieOffset + SAFARI_COOKIE_HEADER_SIZE > pageSize
  ) {
    return null;
  }

  const cookieSize = page.readUInt32LE(cookieOffset);
  if (
    cookieSize < SAFARI_COOKIE_HEADER_SIZE ||
    cookieOffset + cookieSize > pageSize ||
    cookieOffset + cookieSize <= cookieOffset
  ) {
    return null;
  }

  const cookieEnd = cookieOffset + cookieSize;
  const flags = page.readUInt32LE(cookieOffset + 8);
  const hostOffset = page.readUInt32LE(cookieOffset + 16);
  const nameOffset = page.readUInt32LE(cookieOffset + 20);
  const pathOffset = page.readUInt32LE(cookieOffset + 24);
  const valueOffset = page.readUInt32LE(cookieOffset + 28);
  const expiresAt = page.readDoubleLE(cookieOffset + 40);
  const createdAt = page.readDoubleLE(cookieOffset + 48);

  const host = readNullTerminatedString(page, cookieOffset + hostOffset, cookieEnd);
  const name = readNullTerminatedString(page, cookieOffset + nameOffset, cookieEnd);
  const path = readNullTerminatedString(page, cookieOffset + pathOffset, cookieEnd);
  const value = readNullTerminatedString(page, cookieOffset + valueOffset, cookieEnd);
  if (host === null || name === null || path === null || value === null || name === '') {
    return null;
  }

  const { isSecure, isHttpOnly } = mapSafariFlags(flags);
  const expiresUtc = safariTimeToChromeMicros(expiresAt);
  const creationUtc = safariTimeToChromeMicros(createdAt);

  return {
    host_key: host,
    name,
    value,
    path,
    expires_utc: expiresUtc,
    is_secure: isSecure,
    is_httponly: isHttpOnly,
    creation_utc: creationUtc,
    top_frame_site_key: '',
    last_access_utc: creationUtc,
    has_expires: expiresUtc > 0,
    is_persistent: expiresUtc > 0,
    priority: 1,
    samesite: 0,
    source_scheme: isSecure ? 2 : 1,
    source_port: isSecure ? 443 : 80,
    last_update_utc: creationUtc,
  };
}

/**
 * Parse Safari's Cookies.binarycookies file into the same CookieData shape
 * used by Chromium readers. The format is page-based: a big-endian file
 * header points to page blobs, while cookie structs inside pages are
 * little-endian and contain string offsets relative to the cookie start.
 */
export function parseSafariBinaryCookies(buffer: Buffer): CookieData[] {
  if (buffer.length < 8 || buffer.toString('ascii', 0, 4) !== SAFARI_BINARY_COOKIE_MAGIC) {
    throw new Error('Invalid Safari cookie file: missing cook header');
  }

  const pageCount = buffer.readUInt32BE(4);
  const sizeTableEnd = 8 + pageCount * 4;
  if (pageCount === 0 || sizeTableEnd > buffer.length) {
    return [];
  }

  const pageSizes: number[] = [];
  let cursor = sizeTableEnd;
  for (let i = 0; i < pageCount; i++) {
    const pageSize = buffer.readUInt32BE(8 + i * 4);
    if (pageSize <= 0 || cursor + pageSize > buffer.length) {
      throw new Error('Invalid Safari cookie file: page size out of bounds');
    }
    pageSizes.push(pageSize);
    cursor += pageSize;
  }

  const cookies: CookieData[] = [];
  let pageOffset = sizeTableEnd;
  for (const pageSize of pageSizes) {
    const page = buffer.subarray(pageOffset, pageOffset + pageSize);
    if (page.length >= SAFARI_PAGE_HEADER_SIZE) {
      const cookieCount = page.readUInt32LE(4);
      const offsetTableEnd = SAFARI_PAGE_HEADER_SIZE + cookieCount * 4;
      if (offsetTableEnd <= page.length) {
        for (let i = 0; i < cookieCount; i++) {
          const cookieOffset = page.readUInt32LE(SAFARI_PAGE_HEADER_SIZE + i * 4);
          const cookie = parseSafariCookie(page, cookieOffset, pageSize);
          if (cookie !== null) {
            cookies.push(cookie);
          }
        }
      }
    }
    pageOffset += pageSize;
  }

  return cookies;
}
