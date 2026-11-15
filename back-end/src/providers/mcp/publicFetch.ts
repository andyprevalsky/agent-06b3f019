/**
 * Fetch for user-supplied MCP server URLs: http(s) only, public hosts only.
 *
 *   url ──► scheme + hostname check (localhost/.internal/private literals refused)
 *       ├─► redirects followed by hand: every hop's URL is checked first
 *       └─► undici connect-time lookup: every resolved address must be public,
 *           which also covers DNS rebinding.
 *
 * Blackbox tests swap `mcpNetwork` (in-process only) to reach a loopback server;
 * the running backend always uses the guarded pair.
 */
import { lookup as lookupAtConnection } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { isBlockedExternalAddress } from '../publicAddress';

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export class McpUrlError extends Error {}

const lookupPublic: LookupFunction = (hostname, options, callback) => {
  lookupAtConnection(
    hostname,
    { all: true, verbatim: true, family: options.family },
    (error, addresses) => {
      const blocked = error ? null : addresses.find((a) => isBlockedExternalAddress(a.address));
      const failure =
        error ??
        (addresses.length === 0
          ? new McpUrlError(`${hostname} did not resolve`)
          : blocked
            ? new McpUrlError(`${hostname} resolves to a non-public address`)
            : null);
      if (failure) {
        if (options.all === true) callback(failure, []);
        else callback(failure, '', 0);
        return;
      }
      if (options.all === true) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }
  );
};

const dispatcher = new Agent({ connect: { lookup: lookupPublic } });

/** Throws McpUrlError unless `value` is an absolute public http(s) URL. */
export function assertPublicMcpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new McpUrlError('Enter a full MCP server URL, such as https://mcp.example.com/mcp');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new McpUrlError('MCP server URLs must use https://');
  if (url.username || url.password)
    throw new McpUrlError('Put credentials in a header, not in the URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = isIP(host) !== 0;
  if (
    host === 'localhost' ||
    /\.(localhost|local|internal|intranet)$/.test(host) ||
    (literal && isBlockedExternalAddress(host)) ||
    (!literal && !host.includes('.'))
  )
    throw new McpUrlError('MCP server URLs must point to a public host');
  url.hash = '';
  return url;
}

const MAX_REDIRECTS = 5;

/** Follows redirects itself so every hop's URL passes `check` first. */
export const createGuardedFetch =
  (check: (value: string) => URL = assertPublicMcpUrl): FetchLike =>
  async (url, init) => {
    let current = String(url);
    let request: RequestInit = { ...init };
    for (let hop = 0; ; hop += 1) {
      check(current);
      const response = await fetch(current, {
        ...request,
        redirect: 'manual',
        dispatcher,
      } as unknown as RequestInit);
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return response;
      if (hop >= MAX_REDIRECTS) throw new McpUrlError('Too many redirects');
      await response.body?.cancel().catch(() => undefined);
      current = new URL(location, current).toString();
      // 303 (and 301/302 after POST) become GET without a body, as fetch would.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === 'POST')
      )
        request = { ...request, method: 'GET', body: undefined };
    }
  };

const guardedFetch = createGuardedFetch();

/** Indirection so in-process blackbox tests can reach a loopback MCP server. */
export const mcpNetwork: { fetch: FetchLike; checkUrl: (value: string) => URL } = {
  fetch: guardedFetch,
  checkUrl: assertPublicMcpUrl,
};
