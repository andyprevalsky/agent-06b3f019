/**
 * Tilion download by URL through the real files/content route, against vendor answers
 * captured live on 2026-11-15 (live-probes FLAKY ba2764a3, PR #2005):
 *  - 409 `unsupported_subresource_challenge` (status 403): Cloudflare challenged the
 *    session's exit for the file (CI request 5d8f147e430e4130). It surfaced as an
 *    untyped HTTP 500 of 285 bytes. Tilion's navigate clears the challenge inside the
 *    session, and the next files/fetch passes.
 *  - 409 `session_driven_by_client` for up to ~0.1 s after a CDP client disconnects
 *    (detach lag). A bounded retry outlasts it.
 * Negative controls: a client that stays attached is still a typed 409 after the
 * bounded attempts; a challenge navigate could not clear is a typed 409 with no
 * refetch; other 409s still fail, and only a challenge triggers a navigate.
 */
import nodeAssert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { withBrowserProviderServer } from './browser-provider.fixture-server.support';

const VENDOR = 'https://vendor.invalid';
const FILE_URL = 'https://www.w3.org/TR/2003/REC-PNG-20031110/iso_8859-1.txt';
// The CI session and request ids, so the pre-fix symptom is byte-identical (HTTP 500, 285 bytes).
const CI_SESSION_ID = 'sess_6f1b23f58b654b18910c385a99cef301';
const CI_REQUEST_ID = '5d8f147e430e4130';
const CHALLENGE = {
  status: 409,
  body: {
    detail: {
      error: 'unsupported_subresource_challenge',
      status: 403,
      network_error: null,
      size: null,
      limit: 33554432,
    },
  },
};
const BUSY = {
  status: 409,
  body: {
    detail: {
      error: 'session_driven_by_client',
      message:
        'a CDP/Playwright client is attached; drive the session from one place, or close the client',
    },
  },
};
const NO_TAB = { status: 409, body: { detail: { error: 'no_tab', message: 'no open tab' } } };

interface VendorAnswer {
  status: number;
  body: unknown;
}

interface Scenario {
  fetches: VendorAnswer[];
  navigate?: VendorAnswer;
}

async function downloadThroughRoute(
  sessionId: string,
  scenario: Scenario,
  file: Buffer
): Promise<{ status: number; body: Buffer; calls: string[] }> {
  const calls: string[] = [];
  const fetches = [...scenario.fetches];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== VENDOR) return realFetch(input, init);
    const path = url.pathname.replace(`/v1/session/${sessionId}`, '');
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    nodeAssert.equal(init?.method, 'POST', `unexpected Tilion call ${path}`);
    const body = JSON.parse(String(init?.body)) as { url?: string };
    nodeAssert.equal(body.url, FILE_URL, `${path} must address the requested file URL`);
    const headers = { 'x-request-id': CI_REQUEST_ID };
    if (path === '/navigate') {
      nodeAssert(scenario.navigate, 'navigate was not expected in this scenario');
      return Response.json(scenario.navigate.body, { status: scenario.navigate.status, headers });
    }
    nodeAssert.equal(path, '/files/fetch');
    const answer = fetches.shift() ?? {
      status: 200,
      body: { session_id: sessionId, size: file.length, content_base64: file.toString('base64') },
    };
    return Response.json(answer.body, { status: answer.status, headers });
  };
  try {
    const response = await realFetch(
      `${process.env.TEST_BASE_URL}/api/browser-session/${sessionId}/files/content?path=${encodeURIComponent(FILE_URL)}`,
      { headers: { 'x-api-key': String(process.env.BACKEND_API_KEY) } }
    );
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

export async function assertTilionDownloadByUrlSurvivesFilesFetch409s(): Promise<void> {
  const previous = {
    TILION_API_KEY: process.env.TILION_API_KEY,
    TILION_BASE_URL: process.env.TILION_BASE_URL,
    BACKEND_API_KEY: process.env.BACKEND_API_KEY,
    TEST_BASE_URL: process.env.TEST_BASE_URL,
  };
  process.env.TILION_API_KEY = 'test-tilion-key';
  process.env.TILION_BASE_URL = VENDOR;
  process.env.BACKEND_API_KEY = `tilion-file-fetch-${randomUUID()}`;
  // The fixture server starts only when TEST_BASE_URL is set; it then binds its own port.
  process.env.TEST_BASE_URL ??= 'http://127.0.0.1:0';
  let ran = false;
  const userId = `tilion-file-fetch-${randomUUID()}`;
  const context = await prisma.browserContext.create({ data: { userId } });
  const sessionIds = [
    CI_SESSION_ID,
    ...Array.from({ length: 4 }, () => `sess_${randomBytes(16).toString('hex')}`),
  ];
  await prisma.browserSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
  for (const sessionId of sessionIds) {
    await prisma.browserSession.create({
      data: { contextId: context.id, agentId: randomUUID(), sessionId, provider: 'tilion' },
    });
  }
  const [challenged, detaching, attached, uncleared, noTab] = sessionIds as [
    string,
    string,
    string,
    string,
    string,
  ];
  const file = Buffer.from('ISO 8859-1 graphical characters\n'.repeat(200));
  try {
    await withBrowserProviderServer('tilion', async () => {
      ran = true;
      // CI failure: a challenge in front of the file. Cleared in-session, then fetched.
      const cleared = await downloadThroughRoute(
        challenged,
        { fetches: [CHALLENGE], navigate: { status: 200, body: { status: 'ok' } } },
        file
      );
      nodeAssert(
        cleared.status === 200 && cleared.body.equals(file),
        `Tilion download by URL did not match: HTTP ${cleared.status} ${cleared.body.length}/${file.length} bytes`
      );
      nodeAssert.deepEqual(cleared.calls, [
        'POST /files/fetch',
        'POST /navigate',
        'POST /files/fetch',
      ]);

      // A just-closed CDP client still holds the session briefly.
      const settled = await downloadThroughRoute(detaching, { fetches: [BUSY] }, file);
      nodeAssert(
        settled.status === 200 && settled.body.equals(file),
        `Tilion download by URL after a client detached: HTTP ${settled.status} ${settled.body.length}/${file.length} bytes`
      );
      nodeAssert.deepEqual(settled.calls, ['POST /files/fetch', 'POST /files/fetch']);

      // Negative control: a client that stays attached is a typed, bounded refusal.
      const busy = await downloadThroughRoute(
        attached,
        { fetches: [BUSY, BUSY, BUSY, BUSY] },
        file
      );
      nodeAssert.equal(busy.status, 409, `attached client: HTTP ${busy.status}`);
      nodeAssert.equal(
        (JSON.parse(busy.body.toString()) as { error?: string }).error,
        'session_driven_by_client'
      );
      nodeAssert.deepEqual(busy.calls, Array(3).fill('POST /files/fetch'));

      // Negative control: a challenge navigate could not clear is a typed refusal, not a 500.
      const blocked = await downloadThroughRoute(
        uncleared,
        { fetches: [CHALLENGE], navigate: { status: 200, body: { status: 'blocked' } } },
        file
      );
      nodeAssert.equal(blocked.status, 409, `uncleared challenge: HTTP ${blocked.status}`);
      nodeAssert.equal(
        (JSON.parse(blocked.body.toString()) as { error?: string }).error,
        'download_challenged'
      );
      nodeAssert.deepEqual(blocked.calls, ['POST /files/fetch', 'POST /navigate']);

      // Negative control: other 409s are neither retried nor navigated.
      const other = await downloadThroughRoute(noTab, { fetches: [NO_TAB] }, file);
      nodeAssert.notEqual(other.status, 200, 'a no_tab refusal must not pass');
      nodeAssert.deepEqual(other.calls, ['POST /files/fetch']);
    });
    nodeAssert(ran, 'the files/content route server never ran');
  } finally {
    await prisma.browserSession.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await prisma.browserContext.delete({ where: { id: context.id } });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export const tilionFileFetchCases: Array<[string, () => Promise<void>]> = [
  [
    'Tilion download by URL clears a files/fetch challenge and outlasts a detaching client',
    assertTilionDownloadByUrlSurvivesFilesFetch409s,
  ],
];
