#!/usr/bin/env tsx
/**
 * Black-box tests for /api/agent-tools/:agentId/display (inline media) and the
 * sandbox token. The no-questions rule, messages and the `rose` CLI are in
 * agent-tools-requests.blackbox.ts.
 *
 * Invariants covered:
 *   - inline display posts ONE ASSISTANT message per item with a file_pointer the
 *     FE renders inline, kept out of the caller's model context; bytes in storage
 *   - idempotent per (agent, content hash): sequential, concurrent and in-call
 *     repeats never post twice; the same bytes in another agent post there once
 *   - caps: > 20 items → 400; type allowlist image/* video/* text/html (HTML only
 *     when declared .html; HTML renamed .png and SVG → 400), PDF, 3D models and
 *     bundles (agent-tools-display.cases.ts); one bad item rejects the whole
 *     call; SSRF: non-public / non-http URLs refused before any fetch
 *   - the full inline renderer: pages, multi-file bundles, model and PDF viewers
 *     on usercontent with the permissive sandboxed display CSP, and a headless
 *     Chromium render of a three.js CDN page and the model viewer
 *     (agent-tools-display.cases.ts, agent-tools-render.cases.ts)
 *   - `file` resolves a pointer already in the agent's tree (child → root)
 *   - sandbox token scoped to the session's agent (other agent → 403), tampered /
 *     expired / wrong-scope / rose-ui publish token → 401, non-owner API key → 403,
 *     a user-style call without the internal key → refused
 * Usage: bash scripts/run-blackbox-tests.sh agent-tools
 */
import { mintAgentToolsToken } from '../../providers/agentTools/token';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import {
  agentB,
  b64,
  BASE_URL,
  call,
  childA,
  codeToken,
  display,
  displayMessages,
  expectStatus,
  assert,
  items,
  mp4,
  otherA,
  png,
  rootA,
  RUN,
  runSuite,
  storedBytes,
  userA,
  userB,
  type BlackboxTest,
} from './agent-tools.support';
import { assertDisplayCsp, displayRendererCases } from './agent-tools-display.cases';
import { displayRenderCases } from './agent-tools-render.cases';

const tests: BlackboxTest[] = [
  {
    name: 'inline display posts ASSISTANT media rows with file pointers, out of model context',
    fn: async () => {
      const image = png();
      const video = mp4();
      const res = await display(
        rootA,
        { items: [b64(image, 'before.png'), b64(video, 'demo.mp4')], caption: 'Before / demo' },
        { apiKeyUser: userA }
      );
      expectStatus(res, 201, 'display');
      assert(res.data.posted_count === 2, `posted_count 2: ${JSON.stringify(res.data)}`);
      const [first, second] = items(res);
      assert(first.mime_type === 'image/png' && second.mime_type === 'video/mp4', 'sniffed types');
      assert(
        first.file_pointer.storage_path === `${userA}/display/${first.sha256}.png`,
        `content-addressed path under owner: ${first.file_pointer.storage_path}`
      );
      const rows = await displayMessages(rootA);
      assert(rows.length === 2, `two display messages, got ${rows.length}`);
      assert(rows[0].text === 'Before / demo' && rows[1].text === '', 'caption on first item only');
      const metadata = rows[0].metadata as Record<string, unknown>;
      assert(metadata.excludeFromModel === true, 'media rows never enter the model context');
      assert(
        (metadata.requestingAgent as { kind: string }).kind === 'agent',
        'requesting agent recorded'
      );
      const pointer = rows[0].filePointer as Record<string, unknown>;
      assert(
        pointer.mime_type === 'image/png' && pointer.original_filename === 'before.png',
        'pointer'
      );
      const stored = storedBytes(first.file_pointer.storage_path);
      if (stored) assert(stored.equals(image), 'stored bytes equal the displayed bytes');
    },
  },
  {
    name: 'same content is never posted twice (sequential, concurrent, in-call)',
    fn: async () => {
      const before = (await displayMessages(rootA)).length;
      const image = png();
      const first = await display(rootA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(first, 201, 'first');
      const again = await display(rootA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(again, 200, 'retry');
      assert(items(again)[0].status === 'duplicate', 'retry reports duplicate');
      assert(items(again)[0].message_id === items(first)[0].message_id, 'same message id');

      const fresh = png();
      const burst = await Promise.all(
        [0, 1, 2, 3].map(() => display(rootA, { items: [b64(fresh)] }, { apiKeyUser: userA }))
      );
      for (const res of burst) assert(res.status === 200 || res.status === 201, 'burst ok');
      const inCall = await display(
        rootA,
        { items: [b64(png()), b64(image)] },
        { apiKeyUser: userA }
      );
      expectStatus(inCall, 201, 'in-call');
      assert(items(inCall)[1].status === 'duplicate', 'already-displayed item in a new call');

      const rows = await displayMessages(rootA);
      const shas = rows.map(
        (row) => (row.metadata as { display: { sha256: string } }).display.sha256
      );
      assert(new Set(shas).size === shas.length, `no duplicate display rows: ${shas.join(',')}`);
      assert(rows.length === before + 3, `three new rows, got ${rows.length - before}`);

      const elsewhere = await display(otherA, { items: [b64(image)] }, { apiKeyUser: userA });
      expectStatus(elsewhere, 201, 'same bytes, other agent');
      assert((await displayMessages(otherA)).length === 1, 'posted once in the other agent');
    },
  },
  {
    name: 'caps and the image/video/html allowlist reject the whole call',
    fn: async () => {
      const before = (await displayMessages(otherA)).length;
      const tooMany = await display(
        otherA,
        { items: Array.from({ length: 21 }, () => b64(png())) },
        { apiKeyUser: userA }
      );
      expectStatus(tooMany, 400, '21 items');
      const disguised = await display(
        otherA,
        { items: [b64(Buffer.from('<html><script>alert(1)</script>'), 'x.png')] },
        { apiKeyUser: userA }
      );
      expectStatus(disguised, 400, 'html renamed png');
      assert(JSON.stringify(disguised.data).includes('is not a displayable file'), 'type detail');
      const svg = await display(
        otherA,
        { items: [b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg')] },
        { apiKeyUser: userA }
      );
      expectStatus(svg, 400, 'svg');
      const mixed = await display(
        otherA,
        { items: [b64(png()), b64(Buffer.from('plain text'), 'notes.png')] },
        { apiKeyUser: userA }
      );
      expectStatus(mixed, 400, 'mixed valid + invalid');
      const neither = await display(
        otherA,
        { items: [{ filename: 'x.png' }] },
        { apiKeyUser: userA }
      );
      expectStatus(neither, 400, 'item without a source');
      const empty = await display(otherA, { items: [] }, { apiKeyUser: userA });
      expectStatus(empty, 400, 'inline needs an item');
      assert((await displayMessages(otherA)).length === before, 'nothing posted by rejected calls');

      const page = `<!doctype html><html><body><h1>Preview ${RUN}</h1><script>1</script></body></html>`;
      const html = await display(
        otherA,
        { items: [b64(Buffer.from(page), 'preview.html')] },
        { apiKeyUser: userA }
      );
      expectStatus(html, 201, 'declared html page');
      assert(items(html)[0].mime_type === 'text/html', 'text/html allowed when declared');
      assert(items(html)[0].file_pointer.original_filename === 'preview.html', 'html filename');

      // HTML is framed from the sandboxed usercontent origin, never storage.
      const served = items(html)[0].file_pointer as { usercontent_url?: string };
      const url = served.usercontent_url ?? '';
      const match = /\/usercontent\/display\/([0-9a-f-]{36})\/([0-9a-f]{64})\.html$/.exec(url);
      assert(match && match[1] === otherA, `usercontent_url for html: ${url}`);
      const page200 = await fetch(`${BASE_URL}${new URL(url).pathname}`);
      assert(page200.status === 200, `usercontent display page: ${page200.status}`);
      assert(
        (page200.headers.get('content-type') ?? '').startsWith('text/html'),
        `served as html: ${page200.headers.get('content-type')}`
      );
      assertDisplayCsp(page200.headers.get('content-security-policy'), 'display page');
      assert((await page200.text()) === page, 'exact html bytes');
      for (const path of [
        `/usercontent/display/${agentB}/${match[2]}.html`,
        `/usercontent/display/${otherA}/${'0'.repeat(64)}.html`,
        `/usercontent/display/${otherA}/..%2F..%2Fsecret.html`,
        `/usercontent/display/not-a-uuid/${match[2]}.html`,
      ]) {
        const res = await fetch(`${BASE_URL}${path}`);
        assert(res.status === 404, `${path} must 404, got ${res.status}`);
      }
      const png1 = await display(otherA, { items: [b64(png())] }, { apiKeyUser: userA });
      const pngPointer = items(png1)[0].file_pointer as { usercontent_url?: string; kind?: string };
      assert(pngPointer.usercontent_url === undefined, 'images keep their storage pointer only');
      assert(pngPointer.kind === 'image' && items(png1)[0].kind === 'image', 'image kind');
    },
  },
  {
    name: 'URLs must be public http(s)',
    fn: async () => {
      for (const url of [
        'http://127.0.0.1:1/x.png',
        'http://localhost/x.png',
        'http://169.254.169.254/latest/meta-data',
        'file:///etc/passwd',
      ]) {
        const res = await display(otherA, { items: [{ url }] }, { apiKeyUser: userA });
        expectStatus(res, 400, url);
      }
    },
  },
  {
    name: 'file resolves a pointer already in the agent tree',
    fn: async () => {
      const root = await display(
        rootA,
        { items: [b64(png(), 'tree-shot.png')] },
        { apiKeyUser: userA }
      );
      expectStatus(root, 201, 'root display');
      const child = await display(
        childA,
        { items: [{ file: 'tree-shot.png' }] },
        { apiKeyUser: userA }
      );
      expectStatus(child, 201, 'child displays the root file by name');
      assert(items(child)[0].sha256 === items(root)[0].sha256, 'same content');
      const missing = await display(
        childA,
        { items: [{ file: 'nope.png' }] },
        { apiKeyUser: userA }
      );
      expectStatus(missing, 400, 'unknown file');
      const foreign = await display(
        agentB,
        { items: [{ file: items(root)[0].file_pointer.storage_path }] },
        { apiKeyUser: userB }
      );
      expectStatus(foreign, 400, "another user's storage path is not resolvable");
    },
  },
  {
    name: "sandbox token is scoped to the session's agent; owner enforced",
    fn: async () => {
      const token = codeToken(childA);
      const ok = await display(childA, { items: [b64(png())] }, { bearer: token });
      expectStatus(ok, 201, 'token on its agent');
      const row = (await displayMessages(childA)).find((r) => r.id === items(ok)[0].message_id);
      const metadata = row?.metadata as Record<string, unknown>;
      assert(
        metadata.subAgentId === `task-${childA.slice(0, 8)}`,
        'grouped under the code-agent task'
      );
      assert((metadata.requestingAgent as { label: string }).label === 'Claude Code', 'labelled');
      const wrongAgent = await display(rootA, { items: [b64(png())] }, { bearer: token });
      expectStatus(wrongAgent, 403, 'token on a different agent');
      const messageElsewhere = await call(
        'POST',
        `/api/agent-tools/${rootA}/messages`,
        { message: 'x' },
        { bearer: token }
      );
      expectStatus(messageElsewhere, 403, 'message on a different agent');
      const forged = codeToken(rootA, userB);
      expectStatus(
        await display(rootA, { items: [b64(png())] }, { bearer: forged }),
        403,
        'token whose user does not own the agent'
      );
      const tampered = `${token.slice(0, -2)}xx`;
      expectStatus(
        await display(childA, { items: [b64(png())] }, { bearer: tampered }),
        401,
        'tampered'
      );
      const expired = mintAgentToolsToken(userA, childA, { ttlSeconds: -10 }).token;
      expectStatus(
        await display(childA, { items: [b64(png())] }, { bearer: expired }),
        401,
        'expired'
      );
      const wrongScope = mintAgentToolsToken(userA, childA, { scope: 'user-ui:publish' }).token;
      expectStatus(
        await display(childA, { items: [b64(png())] }, { bearer: wrongScope }),
        401,
        'scope'
      );
      const publishToken = mintUserUiPublishToken(userA).token;
      expectStatus(
        await display(childA, { items: [b64(png())] }, { bearer: publishToken }),
        401,
        'rose-ui publish token is not an agent tools token'
      );
      expectStatus(
        await display(rootA, { items: [b64(png())] }, { apiKeyUser: userB }),
        403,
        'API key with a non-owner user'
      );
      const anonymous = await display(rootA, { items: [b64(png())] }, { noAuth: true });
      assert(
        anonymous.status === 401 || anonymous.status === 403,
        `no auth refused: ${anonymous.status}`
      );
    },
  },
  ...displayRendererCases(),
  ...displayRenderCases(),
];

runSuite(tests).catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
