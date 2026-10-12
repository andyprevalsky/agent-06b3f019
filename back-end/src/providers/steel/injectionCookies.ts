import type { Cookie } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { chromeSameSiteToString, cookieUrlFor, normaliseCookie } from '../browserCookies';

type StoredCookieExpiry = Pick<Cookie, 'expiresUtc' | 'hasExpires'>;

function storedCookieExpiry(cookie: StoredCookieExpiry) {
  if (!cookie.hasExpires || cookie.expiresUtc === null || cookie.expiresUtc <= 0n) {
    return undefined;
  }
  return Number(cookie.expiresUtc / 1_000_000n) - 11_644_473_600;
}

export function storedCookieIsLive(cookie: StoredCookieExpiry) {
  const expires = storedCookieExpiry(cookie);
  return expires === undefined || expires > Date.now() / 1000;
}

export function playwrightCookiesFromRows(
  cookies: Cookie[]
): Parameters<BrowserContext['addCookies']>[0] {
  return cookies.filter(storedCookieIsLive).map((cookie) => {
    const canonical = normaliseCookie({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      expires: storedCookieExpiry(cookie),
      secure: cookie.isSecure,
      httpOnly: cookie.isHttpOnly,
      sameSite: chromeSameSiteToString(cookie.sameSite),
    });
    return {
      name: canonical.name,
      value: canonical.value,
      expires: canonical.expires,
      secure: canonical.secure,
      httpOnly: canonical.httpOnly,
      sameSite: canonical.sameSite,
      ...(canonical.domain !== ''
        ? { domain: canonical.domain, path: canonical.path }
        : { url: cookieUrlFor({ ...canonical, domain: cookie.domain }) }),
    };
  });
}
