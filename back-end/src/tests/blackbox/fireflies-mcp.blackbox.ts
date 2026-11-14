/** Fireflies adapter owning-boundary tests: real MCP SDK, mocked remote fetch only. */
import * as mcp from '../../services/integrations/firefliesMcp';
import { FakeFireflies, REDIRECT, NOW, DAY } from './fireflies-sync.blackbox.helpers';
import { assert, equal, runSuite, type TestCase } from './google-workspace-sync.blackbox.helpers';
import type { Fetcher } from '../../services/integrations/meetingProvider';
const tests: TestCase[] = [];
const test = (name: string, fn: TestCase['fn']) => tests.push({ name, fn });
const pending = {
  clientId: 'client',
  verifier: 'v'.repeat(44),
  state: 'state',
  redirectUri: REDIRECT,
};
for (const [status, body] of [
  [502, '<html>gateway</html>'],
  [400, 'null'],
  [400, '[]'],
  [200, ''],
  [200, 'null'],
  [200, '[]'],
  [200, '42'],
  [200, '{}'],
] as const) {
  test(`OAuth HTTP ${status} ${body || 'empty'} preserves typed status context`, async () => {
    const fetcher: Fetcher = async () => new Response(body, { status });
    for (const invoke of [
      () => mcp.exchangeCode(pending, 'code', fetcher),
      () => mcp.beginSignIn(REDIRECT, 'prefix', fetcher),
    ]) {
      const error = await invoke().then(
        () => null,
        (e: unknown) => e
      );
      assert(
        error instanceof mcp.FirefliesMcpError,
        'all malformed responses are FirefliesMcpError'
      );
      assert(error.message.includes(String(status)), 'HTTP status remains inspectable');
      equal(error.reconnect, false, 'malformed body is not a proven revoked grant');
    }
  });
}
for (const code of ['invalid_grant', 'invalid_client'])
  test(`OAuth ${code} classifies reconnect`, async () => {
    const fetcher: Fetcher = async () => Response.json({ error: code }, { status: 400 });
    const error = await mcp.exchangeCode(pending, 'code', fetcher).then(
      () => null,
      (e: unknown) => e
    );
    assert(
      error instanceof mcp.FirefliesMcpError && error.reconnect,
      'proven invalid grant/client reconnects'
    );
    assert(error.message.includes('400'), 'HTTP error context retained');
  });
test('fresh authoritative paginated listing supplies summaries without per-ID requests', async () => {
  const fake = new FakeFireflies();
  for (let i = 0; i < 51; i++) fake.add(`m-${i}`);
  const session = await mcp.FirefliesSession.open(fake.accessToken, fake.fetcher);
  try {
    const list = await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime());
    const notes = await mcp.getMeetingNotes(
      session,
      list.map((m) => m.id)
    );
    equal(notes.size, 51, 'all pages contribute summaries');
    assert(notes.get('m-50')?.summary?.includes('Decision m-50'), 'last page summary');
    equal(
      fake.calls.filter((c) => c.tool === 'fireflies_get_summary').length,
      0,
      'no redundant per-ID quota'
    );
    const changed = fake.meetings.get('m-1');
    assert(changed !== undefined, 'fixture');
    changed.summary = 'Edited in authoritative listing';
    await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime());
    assert(
      (await mcp.getMeetingNotes(session, ['m-1'])).get('m-1')?.summary?.includes('Edited'),
      'each window refreshes edited summary'
    );
    changed.summary = null;
    await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime());
    equal(
      (await mcp.getMeetingNotes(session, ['m-1'])).get('m-1')?.summary,
      null,
      'explicit null clears summary'
    );
    fake.malformed = true;
    await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime()).catch(() => {});
    equal(
      (await mcp.getMeetingNotes(session, ['m-1'])).size,
      0,
      'failed window never reuses preceding notes'
    );
  } finally {
    await session.close();
  }
});
test('HTTP 429 Retry-After retries the same MCP request after the block', async () => {
  const fake = new FakeFireflies();
  fake.add('m');
  let attempts = 0;
  let blockedAt = 0;
  const fetcher: Fetcher = async (input, init) => {
    const body = String(init?.body ?? '');
    if (body.includes('fireflies_get_transcripts')) {
      attempts++;
      if (attempts === 1) {
        blockedAt = Date.now();
        return new Response('limited', { status: 429, headers: { 'Retry-After': '0.02' } });
      }
      assert(Date.now() - blockedAt >= 20, 'Retry-After honored before next request');
    }
    return fake.fetcher(input, init);
  };
  const session = await mcp.FirefliesSession.open(fake.accessToken, fetcher);
  try {
    equal(
      (await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime())).length,
      1,
      'window progresses'
    );
    equal(attempts, 2, 'only rejected request retried');
  } finally {
    await session.close();
  }
});
test('daily 429 does not sleep beyond the existing call budget or lose context', async () => {
  const fake = new FakeFireflies();
  let attempts = 0;
  const fetcher: Fetcher = async (input, init) => {
    if (String(init?.body ?? '').includes('fireflies_get_transcripts')) {
      attempts++;
      return new Response('limited', { status: 429, headers: { 'Retry-After': '86400' } });
    }
    return fake.fetcher(input, init);
  };
  const session = await mcp.FirefliesSession.open(fake.accessToken, fetcher);
  try {
    const error = await mcp.listMeetingsBetween(session, NOW.getTime() - DAY, NOW.getTime()).then(
      () => null,
      (e: unknown) => e
    );
    assert(error instanceof mcp.FirefliesMcpError, 'rate limit is typed');
    assert(
      error.message.includes('429') && error.message.includes('retry'),
      'rate limit delay context'
    );
    equal(attempts, 1, 'no repeated request during daily block');
  } finally {
    await session.close();
  }
});
test('JSON-RPC quota error retries using the documented millisecond reset', async () => {
  const fake = new FakeFireflies();
  fake.add('rpc');
  let attempts = 0;
  let blockedUntil = 0;
  const fetcher: Fetcher = async (input, init) => {
    const message = init?.body ? JSON.parse(String(init.body)) : {};
    if (message.params?.name === 'fireflies_get_transcripts') {
      attempts++;
      if (attempts === 1) {
        blockedUntil = Date.now() + 25;
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32429,
            message: 'Rate limit exceeded',
            data: { retryAfter: blockedUntil },
          },
        });
      }
      assert(Date.now() >= blockedUntil, 'epoch milliseconds respected');
    }
    return fake.fetcher(input, init);
  };
  const session = await mcp.FirefliesSession.open(fake.accessToken, fetcher);
  try {
    equal(
      (await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime())).length,
      1,
      'RPC rate limit recovers'
    );
    equal(attempts, 2, 'only rejected call repeats');
  } finally {
    await session.close();
  }
});
test('structured MCP content preserves summary schema fields and rejects incomplete listings', async () => {
  const fake = new FakeFireflies();
  fake.add('shape');
  let omitSummary = false;
  const fetcher: Fetcher = async (input, init) => {
    const response = await fake.fetcher(input, init);
    const message = init?.body ? JSON.parse(String(init.body)) : {};
    if (message.params?.name !== 'fireflies_get_transcripts') return response;
    const wire = await response.json();
    const value = JSON.parse(wire.result.content[0].text);
    if (omitSummary) delete value.transcripts[0].summary;
    else
      value.transcripts[0].summary = {
        overview: 'Current overview',
        action_items: 'Current action',
        topics_discussed: ['Topic'],
      };
    wire.result = { structuredContent: { data: value }, content: [] };
    return Response.json(wire);
  };
  const session = await mcp.FirefliesSession.open(fake.accessToken, fetcher);
  try {
    await mcp.listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime());
    const summary = (await mcp.getMeetingNotes(session, ['shape'])).get('shape')?.summary;
    assert(
      summary?.includes('Current overview') &&
        summary.includes('Current action') &&
        summary.includes('Topic'),
      'all current summary fields preserved'
    );
    omitSummary = true;
    const error = await mcp
      .listMeetingsBetween(session, NOW.getTime() - 3 * DAY, NOW.getTime())
      .then(
        () => null,
        (e: unknown) => e
      );
    assert(error instanceof mcp.FirefliesMcpError, 'missing summary fails authoritative window');
    equal((await mcp.getMeetingNotes(session, ['shape'])).size, 0, 'no stale summary published');
  } finally {
    await session.close();
  }
});
test('only identified unavailable transcript layers are unknown; malformed data still fails', async () => {
  const fake = new FakeFireflies();
  fake.add('pending');
  let payload: unknown = { transcript: { id: 'pending', title: 'Pending', sentences: null } };
  const fetcher: Fetcher = async (input, init) => {
    const response = await fake.fetcher(input, init);
    const message = init?.body ? JSON.parse(String(init.body)) : {};
    if (message.params?.name !== 'fireflies_get_transcript') return response;
    const wire = await response.json();
    wire.result = { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    return Response.json(wire);
  };
  const session = await mcp.FirefliesSession.open(fake.accessToken, fetcher);
  try {
    equal(
      await mcp.getTranscript(session, 'pending'),
      undefined,
      'nullable layer is not a deletion'
    );
    payload = { transcript: { id: 'pending', title: 'Pending' } };
    equal(
      await mcp.getTranscript(session, 'pending'),
      undefined,
      'identified missing layer remains unknown'
    );
    for (const malformed of [
      {},
      { transcript: null },
      { transcript: { id: 'other', sentences: null } },
      { transcript: { id: 'pending', sentences: {} } },
      { transcript: { sentences: [{ text: 7 }] } },
    ]) {
      payload = malformed;
      const error = await mcp.getTranscript(session, 'pending').then(
        () => null,
        (e: unknown) => e
      );
      assert(error instanceof mcp.FirefliesMcpError, 'malformed payload is not silently skipped');
    }
  } finally {
    await session.close();
  }
});
void runSuite('fireflies MCP', tests);
