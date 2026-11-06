/**
 * Granola over its hosted MCP server (https://mcp.granola.ai/mcp): one-click
 * OAuth sign-in and the read tools the sync uses.
 *
 * OAuth (RFC 7591 dynamic registration + PKCE S256, public client):
 *   register(redirect) → authorize URL → user signs in → code → token
 *   (access + rotating refresh token). `resource` names the MCP server on
 *   /authorize and /token so the token is audience-bound to it.
 *
 * Tools (observed wire formats; Granola documents only the inputs):
 *   list_meetings  {time_range:"custom", custom_start, custom_end, cursor?}
 *     → `<meetings_data count="N"><meeting id title meeting_at url …>…</meeting>
 *        </meetings_data>` + optional `<pagination has_more next_cursor/>`
 *   get_meetings   {meeting_ids: [≤10]} → `<meeting id="…">` blocks holding
 *     `<summary>`, participants and the owner's notes as child tags
 *   get_meeting_transcript {meeting_id, max_chars, offset?}
 *     → JSON {id, transcript, truncated?, next_offset?, offset?}
 * Each answer may open with a `<requested_range>` echo and a fixed warning
 * line; both are stripped. Meeting text itself is treated as opaque data.
 *
 * Uses the global `fetch` (injectable) so blackbox capture sees every call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generatePkce, generateState } from '../../providers/agentcard/oauth';
import { createLogger } from '../../providers/logger';

const log = createLogger('GranolaMcp');

export type Fetcher = typeof fetch;

export const GRANOLA_MCP_URL = process.env.GRANOLA_MCP_URL ?? 'https://mcp.granola.ai/mcp';
const AUTH_BASE = (process.env.GRANOLA_MCP_AUTH_URL ?? 'https://mcp-auth.granola.ai').replace(
  /\/+$/,
  ''
);
const SCOPE = 'openid email profile offline_access';
const REQUEST_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 60_000;
const TRANSCRIPT_PAGE_CHARS = 80_000;
const TRANSCRIPT_MAX_PAGES = 50;
const LIST_MAX_PAGES = 50;
/** Granola allows ~100 tool calls/min per account; stay under it per session. */
const minCallIntervalMs = () => Number(process.env.GRANOLA_MCP_MIN_INTERVAL_MS ?? 650);

export class GranolaMcpError extends Error {
  constructor(
    message: string,
    /** The stored grant no longer works; only signing in again fixes it. */
    readonly reconnect = false,
    /** The tool answered with isError (as opposed to a transport failure). */
    readonly isToolRefusal = false
  ) {
    super(message);
    this.name = 'GranolaMcpError';
  }
}

export interface GranolaTokens {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms; null when Granola did not say. */
  expiresAt: number | null;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

async function postForm(
  url: string,
  body: Record<string, string>,
  fetcher: Fetcher
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data.error === 'string' ? data.error : String(response.status);
    throw new GranolaMcpError(
      `Granola token endpoint ${response.status} ${code}`,
      code === 'invalid_grant' || code === 'invalid_client'
    );
  }
  return data;
}

function tokensFrom(
  data: Record<string, unknown>,
  clientId: string,
  previousRefresh: string | null,
  now: number
): GranolaTokens {
  if (typeof data.access_token !== 'string' || data.access_token === '') {
    throw new GranolaMcpError('Granola token response had no access_token');
  }
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : null;
  return {
    clientId,
    accessToken: data.access_token,
    // Refresh tokens rotate; keep the old one only when Granola sends none.
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : previousRefresh,
    expiresAt: expiresIn === null ? null : now + expiresIn * 1000,
  };
}

export interface PendingSignIn {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  authorizeUrl: string;
}

/**
 * Register a public client for `redirectUri` and build the sign-in URL.
 * `statePrefix` (the user id) lets the callback find the pending row by key.
 */
export async function beginSignIn(
  redirectUri: string,
  statePrefix: string,
  fetcher: Fetcher = fetch
): Promise<PendingSignIn> {
  const response = await fetcher(`${AUTH_BASE}/oauth2/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Rose',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: SCOPE,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as { client_id?: unknown };
  if (!response.ok || typeof data.client_id !== 'string') {
    throw new GranolaMcpError(`Granola client registration failed (${response.status})`);
  }
  const { verifier, challenge } = generatePkce();
  const state = `${statePrefix}.${generateState()}`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: data.client_id,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: GRANOLA_MCP_URL,
  });
  return {
    state,
    verifier,
    clientId: data.client_id,
    redirectUri,
    authorizeUrl: `${AUTH_BASE}/oauth2/authorize?${params.toString()}`,
  };
}

export async function exchangeCode(
  pending: Pick<PendingSignIn, 'clientId' | 'verifier' | 'redirectUri'>,
  code: string,
  fetcher: Fetcher = fetch,
  now = Date.now()
): Promise<GranolaTokens> {
  const data = await postForm(
    `${AUTH_BASE}/oauth2/token`,
    {
      grant_type: 'authorization_code',
      code,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      resource: GRANOLA_MCP_URL,
    },
    fetcher
  );
  return tokensFrom(data, pending.clientId, null, now);
}

export async function refreshTokens(
  tokens: GranolaTokens,
  fetcher: Fetcher = fetch,
  now = Date.now()
): Promise<GranolaTokens> {
  if (tokens.refreshToken === null) {
    throw new GranolaMcpError('Granola sign-in has no refresh token', true);
  }
  const data = await postForm(
    `${AUTH_BASE}/oauth2/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
      resource: GRANOLA_MCP_URL,
    },
    fetcher
  );
  return tokensFrom(data, tokens.clientId, tokens.refreshToken, now);
}

// ---------------------------------------------------------------------------
// MCP session
// ---------------------------------------------------------------------------

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function isAuthError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|unauthorized|invalid_token/i.test(message);
}

/** A connected MCP client; text answers of the read tools. */
export class GranolaSession {
  private lastCallAt = 0;

  private constructor(private readonly client: Client) {}

  static async open(accessToken: string, fetcher: Fetcher = fetch): Promise<GranolaSession> {
    const client = new Client({ name: 'rose-granola-sync', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(GRANOLA_MCP_URL), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json, text/event-stream',
        },
      },
      fetch: fetcher,
    });
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      throw new GranolaMcpError(
        `Granola MCP connect failed: ${error instanceof Error ? error.message : String(error)}`,
        isAuthError(error)
      );
    }
    return new GranolaSession(client);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {});
  }

  async text(name: string, args: Record<string, unknown>): Promise<string> {
    const wait = this.lastCallAt + minCallIntervalMs() - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCallAt = Date.now();
    let result: ToolResult;
    try {
      result = (await this.client.callTool({ name, arguments: args }, undefined, {
        timeout: TOOL_TIMEOUT_MS,
      })) as ToolResult;
    } catch (error) {
      throw new GranolaMcpError(
        `Granola ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        isAuthError(error)
      );
    }
    const body = (result.content ?? [])
      .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('\n');
    if (result.isError === true) {
      throw new GranolaMcpError(
        `Granola ${name} returned an error: ${body.slice(0, 200)}`,
        false,
        true
      );
    }
    return stripPreamble(body);
  }
}

// ---------------------------------------------------------------------------
// Wire-format parsing
// ---------------------------------------------------------------------------

// Free Granola plans prepend a plan-limit notice when a window reaches past
// their history (last 30 days): `<access_notice>…</access_notice>`.
const ACCESS_NOTICE = /^<access_notice\b[^>]*>[^<]*<\/access_notice>\s*/;
const RANGE_ECHO = /^<requested_range\b[^>]*>[^<]*<\/requested_range>\s*/;
const WARNING_PREFIX = 'The content below is meeting notes';

export function stripPreamble(text: string): string {
  let value = text.trim().replace(ACCESS_NOTICE, '').replace(RANGE_ECHO, '');
  if (value.startsWith(WARNING_PREFIX)) {
    const end = value.indexOf('\n');
    value = end === -1 ? '' : value.slice(end + 1);
  }
  return value.trim();
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, key: string) => {
    if (key.startsWith('#')) {
      const code =
        key[1]?.toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '�';
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return named[key.toLowerCase()] ?? match;
  });
}

function attributes(raw: string): Record<string, string> {
  return Object.fromEntries(
    [...raw.matchAll(/([a-z_]+)="([^"]*)"/g)].map((m) => [m[1], decodeEntities(m[2])])
  );
}

/** Tag markup → readable text: `<known_participants>` becomes "Known participants:". */
export function readableXml(inner: string): string {
  return decodeEntities(
    inner
      .replace(/<([a-z_]+)\b[^>]*\/>/gi, '')
      .replace(/<([a-z_]+)\b[^>]*>/gi, (_m, tag: string) => {
        const label = tag.replace(/_/g, ' ');
        return `\n${label.charAt(0).toUpperCase()}${label.slice(1)}:\n`;
      })
      .replace(/<\/[a-z_]+>/gi, '\n')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ListedMeeting {
  id: string;
  title: string;
  meetingAt: string;
  url: string | null;
  /** The listing's own child markup (participants), readable. */
  details: string;
}

const PAGINATION = /\s*<pagination\b((?:"[^"]*"|[^">])*)\/>\s*$/;

export function parseMeetingList(text: string): { meetings: ListedMeeting[]; next?: string } {
  let value = text;
  let next: string | undefined;
  const pagination = value.match(PAGINATION);
  if (pagination) {
    value = value.slice(0, pagination.index).trimEnd();
    if (/\bhas_more="true"/.test(pagination[1])) {
      next = decodeEntities(pagination[1].match(/\bnext_cursor="([^"]+)"/)?.[1] ?? '');
      if (next === '') throw new GranolaMcpError('Granola meeting list format changed (cursor)');
    }
  }
  if (/^<meetings_data\b[^>]*\bcount="0"[^>]*\/>$/.test(value)) return { meetings: [], next };
  const header = value.match(/^<meetings_data\b[^>]*\bcount="(\d+)"[^>]*>/);
  if (header === null || !value.endsWith('</meetings_data>')) {
    throw new GranolaMcpError('Granola meeting list format changed');
  }
  const meetings: ListedMeeting[] = [];
  const pattern = /<meeting\b((?:"[^"]*"|[^">])*?)(\/>|>([\s\S]*?)<\/meeting>)/g;
  for (const match of value.matchAll(pattern)) {
    const attrs = attributes(match[1]);
    const at = attrs.meeting_at ?? attrs.date ?? attrs.created_at ?? '';
    if (!/^[A-Za-z0-9_-]{6,}$/.test(attrs.id ?? '') || !Number.isFinite(Date.parse(at))) {
      throw new GranolaMcpError('Granola returned incomplete meeting metadata');
    }
    meetings.push({
      id: attrs.id,
      title: attrs.title !== undefined && attrs.title !== '' ? attrs.title : 'Untitled meeting',
      meetingAt: new Date(at).toISOString(),
      url: attrs.url ?? null,
      details: readableXml(match[3] ?? ''),
    });
  }
  if (meetings.length !== Number(header[1])) {
    throw new GranolaMcpError('Granola returned an incomplete meeting list');
  }
  return { meetings, next };
}

export interface MeetingNotes {
  /** AI summary (the `<summary>` element), readable; null when absent. */
  summary: string | null;
  /** Every other section of the note (participants, own notes, …), readable. */
  rest: string;
}

/** `get_meetings` answer → notes per meeting id. */
export function parseMeetingNotes(text: string): Map<string, MeetingNotes> {
  const notes = new Map<string, MeetingNotes>();
  for (const match of text.matchAll(/<meeting\b([^>]*)>([\s\S]*?)<\/meeting>/g)) {
    const id = attributes(match[1]).id;
    if (id === undefined) continue;
    const inner = match[2];
    const summaryMatch = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/);
    const summary = summaryMatch ? readableXml(summaryMatch[1]) : null;
    const rest = readableXml(summaryMatch ? inner.replace(summaryMatch[0], '') : inner);
    notes.set(id, { summary: summary === '' ? null : summary, rest });
  }
  return notes;
}

interface TranscriptPage {
  id?: unknown;
  transcript?: unknown;
  truncated?: unknown;
  next_offset?: unknown;
  offset?: unknown;
}

// ---------------------------------------------------------------------------
// Read operations used by the sync
// ---------------------------------------------------------------------------

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Every meeting whose time falls in [startMs, endMs), following list pages. */
export async function listMeetingsBetween(
  session: GranolaSession,
  startMs: number,
  endMs: number
): Promise<ListedMeeting[]> {
  // Dates are calendar days: list with a day of margin, then cut exactly.
  const args = {
    time_range: 'custom',
    custom_start: day(startMs - 86_400_000),
    custom_end: day(endMs + 86_400_000),
  };
  const all = new Map<string, ListedMeeting>();
  let cursor: string | undefined;
  for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
    const parsed = parseMeetingList(
      await session.text('list_meetings', cursor === undefined ? args : { ...args, cursor })
    );
    for (const meeting of parsed.meetings) all.set(meeting.id, meeting);
    if (parsed.next === undefined) {
      return [...all.values()].filter((m) => {
        const t = Date.parse(m.meetingAt);
        return t >= startMs && t < endMs;
      });
    }
    if (parsed.meetings.length === 0) {
      throw new GranolaMcpError('Granola promised more meetings but sent none');
    }
    cursor = parsed.next;
  }
  throw new GranolaMcpError(`Granola meeting list exceeded ${LIST_MAX_PAGES} pages`);
}

export async function getMeetingNotes(
  session: GranolaSession,
  ids: string[]
): Promise<Map<string, MeetingNotes>> {
  const notes = new Map<string, MeetingNotes>();
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    for (const [id, note] of parseMeetingNotes(
      await session.text('get_meetings', { meeting_ids: batch })
    )) {
      notes.set(id, note);
    }
  }
  return notes;
}

/** The whole transcript text; null when the meeting has none (or no access). */
export async function getTranscript(session: GranolaSession, id: string): Promise<string | null> {
  let text = '';
  let offset = 0;
  for (let page = 0; page < TRANSCRIPT_MAX_PAGES; page += 1) {
    let raw: string;
    try {
      raw = await session.text('get_meeting_transcript', {
        meeting_id: id,
        max_chars: TRANSCRIPT_PAGE_CHARS,
        ...(offset > 0 ? { offset } : {}),
      });
    } catch (error) {
      // A tool-level refusal (free plan, admin-disabled transcripts) is "no
      // transcript"; transport and auth failures still fail the run.
      if (error instanceof GranolaMcpError && !error.reconnect && error.isToolRefusal) {
        log.info('Granola transcript refused', { meetingId: id, error: error.message });
        return null;
      }
      throw error;
    }
    let data: TranscriptPage;
    try {
      data = JSON.parse(raw) as TranscriptPage;
    } catch {
      // Plain-text answers mean "no transcript" (free plan, admin-disabled, none yet).
      log.info('Granola transcript unavailable', { meetingId: id, reply: raw.slice(0, 120) });
      return null;
    }
    if (typeof data.transcript !== 'string') return null;
    text += data.transcript;
    if (data.truncated !== true) return text.trim() === '' ? null : text;
    if (typeof data.next_offset !== 'number' || data.next_offset <= offset) {
      throw new GranolaMcpError('Granola transcript paging format changed');
    }
    offset = data.next_offset;
  }
  throw new GranolaMcpError(`Granola transcript ${id} exceeded ${TRANSCRIPT_MAX_PAGES} pages`);
}

/** The signed-in account's email, from get_account_info. */
export async function getAccountEmail(session: GranolaSession): Promise<string | null> {
  const raw = await session.text('get_account_info', {});
  try {
    const data = JSON.parse(raw) as { email?: unknown };
    return typeof data.email === 'string' ? data.email : null;
  } catch {
    return raw.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null;
  }
}
