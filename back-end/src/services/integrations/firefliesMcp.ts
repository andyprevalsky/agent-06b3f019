/**
 * Official Fireflies MCP adapter. Streamable HTTP, public OAuth client + PKCE.
 * Protocol references (verified 2026-11-11):
 * https://docs.fireflies.ai/getting-started/mcp-configuration
 * https://docs.fireflies.ai/mcp-tools/overview
 * https://api.fireflies.ai/.well-known/oauth-authorization-server
 * No GraphQL or experimental search/fetch tools: listing requests JSON explicitly.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generatePkce, generateState } from '../../providers/agentcard/oauth';
import type {
  Fetcher,
  MeetingTokens,
  MeetingPending,
  MeetingRecord,
  MeetingNotes,
} from './meetingProvider';

export const FIREFLIES_MCP_URL = 'https://api.fireflies.ai/mcp';
const ORIGIN = 'https://api.fireflies.ai';
const SCOPE = 'profile email';
const REQUEST_MS = 30_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 200;
export class FirefliesMcpError extends Error {
  constructor(
    message: string,
    readonly reconnect = false,
    readonly status: number | null = null,
    readonly retryAt: number | null = null
  ) {
    super(message);
    this.name = 'FirefliesMcpError';
  }
}

async function post(
  url: string,
  body: string,
  contentType: string,
  fetcher: Fetcher
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  } catch {
    throw new FirefliesMcpError('Fireflies OAuth request failed before an HTTP response');
  }
  const parsed: unknown = await response.json().catch(() => null);
  const data = record(parsed);
  const reconnect = data.error === 'invalid_grant' || data.error === 'invalid_client';
  if (!response.ok)
    throw new FirefliesMcpError(
      `Fireflies OAuth HTTP ${response.status}${reconnect ? ` (${data.error})` : ''}`,
      reconnect,
      response.status
    );
  const required = url.endsWith('/register') ? 'client_id' : 'access_token';
  if (typeof data[required] !== 'string' || !data[required])
    throw new FirefliesMcpError(
      `Fireflies OAuth HTTP ${response.status}: invalid response object or missing ${required}`,
      false,
      response.status
    );
  return data;
}
function tokensFrom(
  data: Record<string, unknown>,
  clientId: string,
  previousRefresh: string | null,
  now: number
): MeetingTokens {
  if (typeof data.access_token !== 'string' || !data.access_token)
    throw new FirefliesMcpError('Fireflies token response missing access_token');
  return {
    clientId,
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh,
    expiresAt: typeof data.expires_in === 'number' ? now + data.expires_in * 1000 : null,
  };
}
export async function beginSignIn(
  redirectUri: string,
  statePrefix: string,
  fetcher: Fetcher = fetch
) {
  const client = await post(
    `${ORIGIN}/register`,
    JSON.stringify({
      client_name: 'Rose',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
    'application/json',
    fetcher
  );
  if (typeof client.client_id !== 'string' || !client.client_id)
    throw new FirefliesMcpError('Fireflies registration missing client_id');
  const { verifier, challenge } = generatePkce();
  const state = `${statePrefix}.${generateState()}`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: FIREFLIES_MCP_URL,
  });
  return {
    state,
    verifier,
    clientId: client.client_id,
    redirectUri,
    authorizeUrl: `${ORIGIN}/authorize?${params}`,
  };
}
export async function exchangeCode(
  pending: MeetingPending,
  code: string,
  fetcher: Fetcher = fetch,
  now = Date.now()
): Promise<MeetingTokens> {
  const data = await post(
    `${ORIGIN}/token`,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: FIREFLIES_MCP_URL,
    }).toString(),
    'application/x-www-form-urlencoded',
    fetcher
  );
  return tokensFrom(data, pending.clientId, null, now);
}
export async function refreshTokens(
  tokens: MeetingTokens,
  fetcher: Fetcher = fetch,
  now = Date.now()
): Promise<MeetingTokens> {
  if (!tokens.refreshToken)
    throw new FirefliesMcpError('Fireflies refresh token unavailable', true);
  const data = await post(
    `${ORIGIN}/token`,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: FIREFLIES_MCP_URL,
    }).toString(),
    'application/x-www-form-urlencoded',
    fetcher
  );
  return tokensFrom(data, tokens.clientId, tokens.refreshToken, now);
}
function authFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 401;
}
/** Optional scheduler capability; only an authenticated provider throttle carries a reset. */
export function getRetryAt(error: unknown): number | null {
  return error instanceof FirefliesMcpError && error.status === 429 ? error.retryAt : null;
}
async function waitForRateLimit(retryAt: number, deadline: number, signal?: AbortSignal) {
  const valid = Number.isFinite(retryAt) && !Number.isNaN(new Date(retryAt).getTime());
  const wait = retryAt - Date.now();
  if (!valid || wait <= 0 || retryAt >= deadline)
    throw new FirefliesMcpError(
      `Fireflies MCP rate limited (429): retry after ${valid ? new Date(retryAt).toISOString() : 'provider rate-limit reset'}; cannot retry within the existing request budget`,
      false,
      429,
      valid ? retryAt : null
    );
  const boundedSignal = signal ?? AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  // Timers can wake early; never send another quota-charged request before reset.
  while (Date.now() < retryAt) {
    await delay(Math.max(1, retryAt - Date.now()), undefined, { signal: boundedSignal });
  }
}
export class FirefliesSession {
  // Replaced on every authoritative window; never shared across sessions or syncs.
  readonly listedNotes = new Map<string, MeetingNotes>();
  private constructor(private readonly client: Client) {}
  static async open(accessToken: string, fetcher: Fetcher = fetch): Promise<FirefliesSession> {
    const client = new Client({ name: 'rose-fireflies-sync', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(FIREFLIES_MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      fetch: async (input, init) => {
        const message = typeof init?.body === 'string' ? record(JSON.parse(init.body)) : {};
        const budget = message.method === 'initialize' ? REQUEST_MS : 60_000;
        const deadline = Date.now() + budget;
        const signal = AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(budget),
        ]);
        for (;;) {
          const response = await fetcher(input, { ...init, signal });
          if (response.status !== 429) return response;
          const header = response.headers.get('Retry-After');
          const seconds = header === null || header.trim() === '' ? NaN : Number(header);
          const retryAt = Number.isFinite(seconds)
            ? Date.now() + seconds * 1000
            : Date.parse(header ?? '');
          await response.body?.cancel();
          await waitForRateLimit(retryAt, deadline, signal);
        }
      },
    });
    try {
      await client.connect(transport, { timeout: REQUEST_MS });
      return new FirefliesSession(client);
    } catch (error) {
      await client.close().catch(() => {});
      if (authFailure(error)) throw new FirefliesMcpError('Fireflies access token rejected', true);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.listedNotes.clear();
    await this.client.close().catch(() => {});
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result;
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        result = await this.client.callTool({ name, arguments: args }, undefined, {
          timeout: Math.max(1, deadline - Date.now()),
        });
        break;
      } catch (error) {
        if (authFailure(error))
          throw new FirefliesMcpError('Fireflies access token rejected', true);
        const limited = record(error);
        if (limited.code !== -32429) throw error;
        const retryAt = record(limited.data).retryAfter;
        await waitForRateLimit(typeof retryAt === 'number' ? retryAt : NaN, deadline);
      }
    }
    if (result.isError === true) throw new FirefliesMcpError(`Fireflies ${name} refused`);
    if ('structuredContent' in result && result.structuredContent !== undefined)
      return result.structuredContent;
    const text = (result.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function unwrap(value: unknown, key: string): unknown {
  const obj = record(value);
  if (key in obj) return obj[key];
  const data = record(obj.data);
  if (key in data) return data[key];
  return value;
}
function render(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(render).filter(Boolean).join('\n');
  if (typeof value === 'object')
    return Object.entries(record(value))
      .map(([key, val]) => `${key}: ${render(val)}`)
      .join('\n');
  return String(value);
}
export async function getAccountEmail(session: FirefliesSession): Promise<string | null> {
  const user = record(unwrap(await session.call('fireflies_get_user', {}), 'user'));
  return typeof user.email === 'string' ? user.email : null;
}
export async function listMeetingsBetween(
  session: FirefliesSession,
  startMs: number,
  endMs: number
): Promise<MeetingRecord[]> {
  session.listedNotes.clear();
  const notes = new Map<string, MeetingNotes>();
  const meetings = new Map<string, MeetingRecord>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await session.call('fireflies_get_transcripts', {
      fromDate: new Date(startMs).toISOString().slice(0, 10),
      toDate: new Date(endMs).toISOString().slice(0, 10),
      limit: PAGE_SIZE,
      skip: page * PAGE_SIZE,
      format: 'json',
    });
    // The live MCP replies {data: [...], warning?}; older shapes nest {transcripts: [...]}.
    const envelope = record(raw).data;
    const result = Array.isArray(envelope) ? envelope : unwrap(raw, 'transcripts');
    if (!Array.isArray(result))
      throw new FirefliesMcpError(
        'Fireflies listing is not a JSON transcript array; refusing reconciliation'
      );
    let added = 0;
    for (const value of result) {
      const m = record(value);
      const date = m.date ?? m.dateString;
      const ms =
        typeof date === 'number' ? date : typeof date === 'string' ? Date.parse(date) : NaN;
      if (typeof m.id !== 'string' || !m.id || !Number.isFinite(ms) || typeof m.title !== 'string')
        throw new FirefliesMcpError(
          'Fireflies listing contains an invalid meeting; refusing reconciliation'
        );
      if (!Object.hasOwn(m, 'summary'))
        throw new FirefliesMcpError('Fireflies listing missing summary; refusing reconciliation');
      notes.set(m.id, { summary: m.summary === null ? null : render(m.summary), rest: '' });
      if (!meetings.has(m.id)) added++;
      meetings.set(m.id, {
        id: m.id,
        title: m.title,
        meetingAt: new Date(ms).toISOString(),
        url: typeof m.transcript_url === 'string' ? m.transcript_url : null,
        details: render({
          participants: m.participants ?? [],
          organizer: m.organizer_email ?? m.organizerEmail ?? '',
        }),
      });
    }
    if (result.length < PAGE_SIZE) {
      const listed = [...meetings.values()].filter(
        (m) => Date.parse(m.meetingAt) >= startMs && Date.parse(m.meetingAt) < endMs
      );
      for (const meeting of listed) {
        const note = notes.get(meeting.id);
        if (note !== undefined) session.listedNotes.set(meeting.id, note);
      }
      return listed;
    }
    if (page > 0 && added === 0)
      throw new FirefliesMcpError('Fireflies pagination did not advance');
  }
  throw new FirefliesMcpError(
    'Fireflies pagination exceeded page budget; refusing partial reconciliation'
  );
}
export async function getMeetingNotes(
  session: FirefliesSession,
  ids: string[]
): Promise<Map<string, MeetingNotes>> {
  const notes = new Map<string, MeetingNotes>();
  for (const id of ids) {
    const note = session.listedNotes.get(id);
    if (note !== undefined) notes.set(id, note);
  }
  return notes;
}
export async function getTranscript(
  session: FirefliesSession,
  id: string
): Promise<string | null | undefined> {
  const value = unwrap(
    await session.call('fireflies_get_transcript', { transcriptId: id }),
    'transcript'
  );
  if (typeof value === 'string') return value.trim() ? value : null;
  const obj = record(value);
  // A known transcript without its nullable sentence layer is not a deletion.
  // Empty/foreign envelopes and present non-array layers remain protocol errors.
  if (obj.id === id && (obj.sentences === null || !Object.hasOwn(obj, 'sentences')))
    return undefined;
  if (!Array.isArray(obj.sentences))
    throw new FirefliesMcpError('Fireflies transcript missing sentences');
  return (
    obj.sentences
      .map((value: unknown) => {
        const sentence = record(value);
        if (typeof sentence.text !== 'string')
          throw new FirefliesMcpError('Fireflies sentence missing text');
        return `[${sentence.start_time ?? ''} - ${sentence.end_time ?? ''}] ${sentence.speaker_name ?? 'Speaker'}: ${sentence.text}`;
      })
      .join('\n') || null
  );
}
