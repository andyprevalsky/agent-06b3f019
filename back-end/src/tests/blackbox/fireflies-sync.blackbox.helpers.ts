/** Official Fireflies OAuth + Streamable HTTP protocol mocked only at fetch. */
import type { Fetcher } from '../../services/integrations/meetingProvider';
import { assert } from './google-workspace-sync.blackbox.helpers';
export const REDIRECT = 'http://localhost:5050/integrations/fireflies/callback';
export const DAY = 86_400_000;
// Claims use PostgreSQL's clock. A fixture clock in the future would make a
// fresh real DB lease immediately stale; keep all simulated runs in the past.
export const NOW = new Date(Date.now() - DAY);
export const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
export interface FakeTranscript {
  id: string;
  title: string;
  date: number;
  summary: string;
  transcript: string;
}
export class FakeFireflies {
  meetings = new Map<string, FakeTranscript>();
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  forms: URLSearchParams[] = [];
  email = 'fireflies@example.com';
  accessToken = 'fireflies-access-0';
  refreshToken = 'fireflies-refresh-0';
  expiresIn = 3600;
  revoked = false;
  malformed = false;
  repeatPage = false;
  beforeTool: ((name: string) => Promise<void>) | null = null;
  expireOn: string | null = null;
  add(id: string, days = 1) {
    this.meetings.set(id, {
      id,
      title: `Meeting ${id}`,
      date: Date.parse(ago(days)),
      summary: `Decision ${id}: approve Calypso`,
      transcript: `Hello ${id}, this is the conversation.`,
    });
  }
  private json(value: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  fetcher: Fetcher = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(url.origin === 'https://api.fireflies.ai', 'only official Fireflies host');
    if (url.pathname === '/register') {
      const body = JSON.parse(String(init?.body)) as {
        redirect_uris: string[];
        token_endpoint_auth_method: string;
      };
      assert(body.redirect_uris[0] === REDIRECT, 'register callback');
      assert(body.token_endpoint_auth_method === 'none', 'public client');
      return this.json({ client_id: 'fireflies-client' }, 201);
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(String(init?.body));
      this.forms.push(form);
      assert(form.get('resource') === 'https://api.fireflies.ai/mcp', 'audience bound token');
      if (form.get('grant_type') === 'authorization_code') {
        assert((form.get('code_verifier')?.length ?? 0) >= 40, 'PKCE verifier');
        assert(form.get('redirect_uri') === REDIRECT, 'code callback');
      } else if (this.revoked || form.get('refresh_token') !== this.refreshToken)
        return this.json({ error: 'invalid_grant' }, 400);
      this.accessToken = `fireflies-access-${this.forms.length}`;
      this.refreshToken = `fireflies-refresh-${this.forms.length}`;
      return this.json({
        access_token: this.accessToken,
        refresh_token: this.refreshToken,
        expires_in: this.expiresIn,
        token_type: 'Bearer',
      });
    }
    assert(url.pathname === '/mcp', `MCP path ${url.pathname}`);
    if (init?.method !== 'POST') return new Response(null, { status: 405 });
    if (
      this.revoked ||
      new Headers(init.headers).get('authorization') !== `Bearer ${this.accessToken}`
    )
      return this.json({ error: 'invalid_token' }, 401);
    const message = JSON.parse(String(init.body)) as {
      id?: number;
      method: string;
      params?: { name: string; arguments: Record<string, unknown> };
    };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown = {};
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fireflies', version: '1' },
      };
    if (message.method === 'tools/call') {
      const tool = message.params?.name ?? '';
      const args = message.params?.arguments ?? {};
      this.calls.push({ tool, args });
      if (this.expireOn === tool) {
        this.expireOn = null;
        this.accessToken = 'expired';
        return this.json({ error: 'invalid_token' }, 401);
      }
      await this.beforeTool?.(tool);
      let value: unknown;
      if (tool === 'fireflies_get_user') value = { user: { email: this.email } };
      else if (tool === 'fireflies_get_transcripts') {
        assert(
          args.format === 'json' && args.limit === 50,
          'documented JSON listing with page limit'
        );
        const hits = [...this.meetings.values()].filter(
          (m) =>
            new Date(m.date).toISOString().slice(0, 10) >= String(args.fromDate) &&
            new Date(m.date).toISOString().slice(0, 10) <= String(args.toDate)
        );
        const skip = this.repeatPage ? 0 : Number(args.skip);
        value = this.malformed
          ? { message: 'temporarily unavailable' }
          : {
              transcripts: hits.slice(skip, skip + 50).map((m) => ({
                id: m.id,
                title: m.title,
                date: m.date,
                participants: ['ada@example.com'],
                transcript_url: `https://app.fireflies.ai/view/${m.id}`,
              })),
            };
      } else {
        assert(typeof args.transcriptId === 'string', 'documented transcriptId input');
        const m = this.meetings.get(String(args.transcriptId));
        assert(m !== undefined, 'meeting exists');
        if (tool === 'fireflies_get_summary') value = { summary: { overview: m.summary } };
        else if (tool === 'fireflies_get_transcript')
          value = {
            transcript: {
              sentences: [{ speaker_name: 'Ada', start_time: 0, end_time: 3, text: m.transcript }],
            },
          };
        else throw new Error(`Unexpected tool ${tool}`);
      }
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
    return this.json(
      { jsonrpc: '2.0', id: message.id, result },
      200,
      message.method === 'initialize' ? { 'mcp-session-id': 'fireflies-session' } : {}
    );
  };
}
