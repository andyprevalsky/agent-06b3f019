/**
 * A fake GitHub REST endpoint that answers rate limits with what real GitHub
 * answered, never with invented text.
 *
 *   fixtures/github-rate-limit/primary-403.json    real capture (status, every header, body)
 *   fixtures/github-rate-limit/secondary-403.json  real status + body from production logs
 *
 * Each fixture records its source. The drift test
 * (tests/unit/github-rate-limit-fixtures.test.ts) asserts that this server's
 * un-parameterised responses equal the fixtures byte for byte.
 *
 * Only two values may be parameterised, and only because tests need a reset
 * time relative to "now": `x-ratelimit-reset` (a real header on the primary
 * capture) and `retry-after` (a header GitHub documents for secondary limits;
 * the real secondary response was logged without headers, so it is added only
 * when a test asks for it). Everything else is verbatim. Transport framing is
 * HTTP/1.1 here, HTTP/2 on the wire in the capture.
 *
 * The fake records method and path, never an Authorization value.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

export type RateLimitKind = 'primary' | 'secondary';

export interface FixtureResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

interface FixtureFile extends FixtureResponse {
  source: string;
  documentation: string;
}

const FIXTURE_DIR = join(__dirname, '..', 'fixtures', 'github-rate-limit');

export function loadRateLimitFixture(kind: RateLimitKind): FixtureFile {
  const file = join(FIXTURE_DIR, `${kind}-403.json`);
  return JSON.parse(readFileSync(file, 'utf8')) as FixtureFile;
}

export interface RateLimitOverrides {
  /** Replaces `x-ratelimit-reset` (UTC epoch seconds). Primary responses only. */
  resetEpochS?: number;
  /** Adds `retry-after` (seconds). */
  retryAfterS?: number;
}

/** The fixture's response, with the two documented time headers parameterised. */
export function rateLimitResponse(
  kind: RateLimitKind,
  overrides: RateLimitOverrides = {}
): FixtureResponse {
  const fixture = loadRateLimitFixture(kind);
  const headers = fixture.headers.map(([name, value]): [string, string] =>
    name === 'x-ratelimit-reset' && overrides.resetEpochS !== undefined
      ? [name, String(overrides.resetEpochS)]
      : [name, value]
  );
  if (overrides.retryAfterS !== undefined)
    headers.push(['retry-after', String(overrides.retryAfterS)]);
  return { status: fixture.status, headers, body: fixture.body };
}

/** The fixture as a fetch Response, for tests that stub `fetch` instead of using the server. */
export function toResponse(reply: FixtureResponse): Response {
  const headers = new Headers();
  for (const [name, value] of reply.headers) headers.append(name, value);
  return new Response(reply.body, { status: reply.status, headers });
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  authenticated: boolean;
}

export type FakeReply = FixtureResponse | { status?: number; json: unknown };

export interface FakeGithub {
  /** Value for GITHUB_API_BASE_URL. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function send(res: ServerResponse, reply: FakeReply): void {
  if ('json' in reply) {
    res.statusCode = reply.status ?? 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(reply.json));
    return;
  }
  res.statusCode = reply.status;
  for (const [name, value] of reply.headers) res.setHeader(name, value);
  res.end(reply.body);
}

export async function startFakeGithub(
  handler: (request: RecordedRequest, req: IncomingMessage) => FakeReply
): Promise<FakeGithub> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://github.test');
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.search,
      authenticated: typeof req.headers.authorization === 'string',
    };
    requests.push(request);
    req.resume();
    send(res, handler(request, req));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
