#!/usr/bin/env tsx
/**
 * Black-box tests for /api/user-ui + /usercontent (per-user rose_user_ui).
 *
 * Domain surface:
 *   POST /api/user-ui/versions               publish a bundle (JWT, API key, or publish token)
 *   POST /api/user-ui/versions/:id/activate  move the user's active pointer
 *   GET  /api/user-ui/active                 { versionId, manifest, baseUrl } | { versionId: null }
 *   GET  /api/user-ui/versions               list the caller's versions
 *   POST /api/user-ui/publish-token          short-lived sandbox publish token
 *   GET  /usercontent/:versionId/*           published bytes, immutable + strict CSP
 *
 * Invariants covered:
 *   - auth boundary: no credentials → 401; publish token only works on publish
 *   - publish/activate/rollback/list round trip; activate:false leaves pointer
 *   - validation: bad manifest, missing referenced file, missing rose-ui.json,
 *     unsafe theme value, path traversal / absolute / dot paths, per-file cap → 400
 *   - tenant isolation: user B cannot activate A's version (404) or list it
 *   - usercontent: exact bytes (text + binary), content type, CSP, immutable
 *     cache, no cookies; unknown path / non-uuid / encoded traversal → 404
 *   - publish token: mint → publish as the owner; expired, wrong-scope and
 *     tampered tokens → 401
 *   - the shipped seed bundle + `rose-ui publish` CLI publish end to end
 *
 * Usage: bash scripts/run-blackbox-tests.sh user-ui
 */
import { execFile } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { config } from 'dotenv';
import { mintUserUiPublishToken } from '../../providers/userUi/publishToken';
import { userUiCliScript, userUiSeedFiles } from '../../providers/userUi/seed';
import {
  materializeUserUiInLocalHome,
  prepareUserUiWorkspace,
} from '../../providers/userUi/workspace';
import { userUiExampleCases } from './user-ui-examples.cases';
config();

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';
const execFileAsync = promisify(execFile);

const EXPECTED_CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; " +
  "connect-src 'self'; worker-src blob:; frame-ancestors *";

interface Session {
  token: string;
  userId: string;
}
interface Res {
  status: number;
  data: Record<string, unknown>;
  headers: Headers;
}

async function call(path: string, init: RequestInit & { auth?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.auth !== undefined) headers.Authorization = `Bearer ${init.auth}`;
  const response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text };
  }
  return { status: response.status, data, headers: response.headers };
}

function expectStatus(res: Res, status: number, label: string): void {
  if (res.status !== status) {
    throw new Error(
      `${label}: expected ${status}, got ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`
    );
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function anonymousSession(): Promise<Session> {
  const res = await call('/api/auth/anonymous', { method: 'POST' });
  expectStatus(res, 200, 'anonymous session');
  const data = res.data as { session: { access_token: string }; user: { id: string } };
  return { token: data.session.access_token, userId: data.user.id };
}

type FileSpec = Record<string, string | Buffer>;
const b64 = (value: string | Buffer) =>
  (typeof value === 'string' ? Buffer.from(value, 'utf8') : value).toString('base64');
const bundle = (files: FileSpec) =>
  Object.entries(files).map(([path, content]) => ({ path, contentBase64: b64(content) }));

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xef, 0xbf, 0xbd,
]);
const HELLO_HTML = '<!doctype html><p id="x">hello inline</p>';

function validFiles(extra: FileSpec = {}): FileSpec {
  return {
    'rose-ui.json': JSON.stringify({
      version: 1,
      theme: 'root/theme.json',
      inline: {
        hello: {
          entry: 'inline/hello/index.html',
          summary: 'Hello',
          poster: 'inline/hello/poster.png',
        },
      },
      slots: { background: { entry: 'root/slots/background/index.html' } },
      capabilities: ['read', 'subscribe'],
    }),
    'root/theme.json': JSON.stringify({
      tokens: { '--primary': '#7c3aed', '--radius': '14px' },
      background: { image: 'root/assets/bg.png', fadeAfterFirstMessage: 0.2 },
    }),
    'root/assets/bg.png': PNG,
    'root/slots/background/index.html': '<!doctype html><canvas></canvas>',
    'inline/hello/index.html': HELLO_HTML,
    'inline/hello/poster.png': PNG,
    ...extra,
  };
}

async function publish(auth: string, files: FileSpec, activate?: boolean) {
  return call('/api/user-ui/versions', {
    method: 'POST',
    auth,
    body: JSON.stringify({ files: bundle(files), ...(activate === undefined ? {} : { activate }) }),
  });
}

async function active(auth: string) {
  const res = await call('/api/user-ui/active', { auth });
  expectStatus(res, 200, 'GET active');
  return res.data as {
    versionId: string | null;
    manifest?: Record<string, unknown>;
    baseUrl?: string;
  };
}

let userA: Session;
let userB: Session;
let firstVersionId = '';

const tests: { name: string; fn: () => Promise<void> }[] = [
  {
    name: 'auth boundary -- no credentials → 401',
    fn: async () => {
      expectStatus(await call('/api/user-ui/active'), 401, 'active');
      expectStatus(
        await call('/api/user-ui/versions', { method: 'POST', body: '{}' }),
        401,
        'publish'
      );
    },
  },
  {
    name: 'active is null before any publish',
    fn: async () => {
      const a = await active(userA.token);
      assert(a.versionId === null, `expected null active, got ${a.versionId}`);
    },
  },
  {
    name: 'publish → active → list',
    fn: async () => {
      const res = await publish(userA.token, validFiles());
      expectStatus(res, 201, 'publish');
      firstVersionId = String(res.data.versionId);
      assert(/^[0-9a-f-]{36}$/.test(firstVersionId), 'versionId is a uuid');
      const a = await active(userA.token);
      assert(a.versionId === firstVersionId, 'published version becomes active by default');
      assert((a.manifest as { version: number }).version === 1, 'manifest returned');
      assert(a.baseUrl?.endsWith(`/usercontent/${firstVersionId}/`), `baseUrl ${a.baseUrl}`);
      const list = await call('/api/user-ui/versions', { auth: userA.token });
      expectStatus(list, 200, 'list');
      const versions = list.data.versions as {
        versionId: string;
        active: boolean;
        fileCount: number;
      }[];
      const row = versions.find((v) => v.versionId === firstVersionId);
      assert(row?.active === true && row.fileCount === 6, `list row ${JSON.stringify(row)}`);
    },
  },
  {
    name: 'activate:false keeps pointer; activate + rollback move it',
    fn: async () => {
      const res = await publish(userA.token, validFiles({ 'extra.txt': 'v2' }), false);
      expectStatus(res, 201, 'publish v2');
      const second = String(res.data.versionId);
      assert((await active(userA.token)).versionId === firstVersionId, 'pointer unchanged');
      expectStatus(
        await call(`/api/user-ui/versions/${second}/activate`, {
          method: 'POST',
          auth: userA.token,
        }),
        200,
        'activate v2'
      );
      assert((await active(userA.token)).versionId === second, 'pointer moved to v2');
      expectStatus(
        await call(`/api/user-ui/versions/${firstVersionId}/activate`, {
          method: 'POST',
          auth: userA.token,
        }),
        200,
        'rollback'
      );
      assert((await active(userA.token)).versionId === firstVersionId, 'rolled back');
    },
  },
  {
    name: 'invalid bundles → 400',
    fn: async () => {
      const cases: [string, FileSpec][] = [
        ['bad version', validFiles({ 'rose-ui.json': JSON.stringify({ version: 2 }) })],
        ['unknown key', validFiles({ 'rose-ui.json': JSON.stringify({ version: 1, nope: true }) })],
        [
          'bad slot',
          validFiles({
            'rose-ui.json': JSON.stringify({ version: 1, slots: { footer: { entry: 'a.html' } } }),
          }),
        ],
        [
          'missing ref',
          validFiles({
            'rose-ui.json': JSON.stringify({
              version: 1,
              shell: { entry: 'root/shell/index.html' },
            }),
          }),
        ],
        ['no manifest', { 'a.html': 'x' }],
        ['manifest not json', validFiles({ 'rose-ui.json': '{nope' })],
        [
          'unsafe theme',
          validFiles({
            'root/theme.json': JSON.stringify({ tokens: { '--bg': 'url(https://x)' } }),
          }),
        ],
        [
          'bad view name',
          validFiles({
            'rose-ui.json': JSON.stringify({
              version: 1,
              inline: { Bad_View: { entry: 'a.html' } },
            }),
            'a.html': 'x',
          }),
        ],
        [
          'ref traversal',
          validFiles({ 'rose-ui.json': JSON.stringify({ version: 1, theme: '../theme.json' }) }),
        ],
      ];
      for (const [label, files] of cases) {
        const res = await publish(userA.token, files);
        expectStatus(res, 400, label);
        assert(Array.isArray(res.data.details), `${label}: details listed`);
      }
    },
  },
  {
    name: 'path traversal / absolute / dot paths rejected',
    fn: async () => {
      for (const path of [
        '../evil.html',
        'a/../../evil.html',
        '/etc/passwd',
        '.env',
        'a/.git/config',
        'a\\b.html',
        'C:/x',
      ]) {
        const res = await publish(userA.token, validFiles({ [path]: 'x' }));
        expectStatus(res, 400, `path ${path}`);
      }
    },
  },
  {
    name: 'per-file size cap → 400',
    fn: async () => {
      const res = await publish(
        userA.token,
        validFiles({ 'big.bin': Buffer.alloc(10 * 1024 * 1024 + 1) })
      );
      expectStatus(res, 400, 'oversized file');
    },
  },
  {
    name: 'tenant isolation -- B cannot activate or list A versions',
    fn: async () => {
      const res = await call(`/api/user-ui/versions/${firstVersionId}/activate`, {
        method: 'POST',
        auth: userB.token,
      });
      expectStatus(res, 404, 'B activates A');
      assert((await active(userB.token)).versionId === null, 'B active unchanged');
      const list = await call('/api/user-ui/versions', { auth: userB.token });
      expectStatus(list, 200, 'B list');
      assert((list.data.versions as unknown[]).length === 0, 'B sees none of A versions');
      expectStatus(
        await call('/api/user-ui/versions/not-a-uuid/activate', {
          method: 'POST',
          auth: userA.token,
        }),
        404,
        'non-uuid activate'
      );
    },
  },
  {
    name: 'usercontent serves exact bytes with CSP + immutable cache',
    fn: async () => {
      const base = (await active(userA.token)).baseUrl!;
      const html = await fetch(`${base}inline/hello/index.html`);
      assert(html.status === 200, `html status ${html.status}`);
      assert((await html.text()) === HELLO_HTML, 'html bytes');
      assert(html.headers.get('content-type')?.startsWith('text/html'), 'html content type');
      assert(
        html.headers.get('content-security-policy') === EXPECTED_CSP,
        `csp ${html.headers.get('content-security-policy')}`
      );
      assert(
        html.headers.get('cache-control') === 'public, max-age=31536000, immutable',
        'cache-control'
      );
      assert(html.headers.get('set-cookie') === null, 'no cookies');
      const png = await fetch(`${base}root/assets/bg.png`);
      assert(png.status === 200 && png.headers.get('content-type') === 'image/png', 'png served');
      assert(Buffer.from(await png.arrayBuffer()).equals(PNG), 'binary bytes round-trip');
      for (const url of [
        `${base}missing.html`,
        `${base}%2e%2e/%2e%2e/etc/passwd`,
        `${base}.rose-index.json`,
        `${BASE_URL}/usercontent/not-a-uuid/inline/hello/index.html`,
        `${BASE_URL}/usercontent/00000000-0000-4000-8000-000000000000/inline/hello/index.html`,
      ]) {
        const res = await fetch(url);
        assert(res.status === 404, `${url} → ${res.status}`);
      }
    },
  },
  {
    name: 'publish token -- mint, publish as owner; expired/scope/tampered → 401',
    fn: async () => {
      const minted = await call('/api/user-ui/publish-token', {
        method: 'POST',
        auth: userB.token,
      });
      expectStatus(minted, 201, 'mint');
      const token = String(minted.data.token);
      assert(token.startsWith('ruip.'), 'token prefix');
      const res = await publish(token, validFiles());
      expectStatus(res, 201, 'publish with token');
      assert(
        (await active(userB.token)).versionId === res.data.versionId,
        'token publishes for its owner'
      );
      expectStatus(
        await call('/api/user-ui/active', { auth: token }),
        401,
        'token is publish-only'
      );
      const expired = mintUserUiPublishToken(userB.userId, { ttlSeconds: -10 }).token;
      expectStatus(await publish(expired, validFiles()), 401, 'expired');
      const scoped = mintUserUiPublishToken(userB.userId, { scope: 'user-ui:read' }).token;
      expectStatus(await publish(scoped, validFiles()), 401, 'wrong scope');
      const forged = mintUserUiPublishToken(userA.userId).token.replace(/\.[^.]+$/, '.AAAA');
      expectStatus(await publish(forged, validFiles()), 401, 'tampered');
    },
  },
  {
    name: 'seed bundle + rose-ui CLI publish end to end',
    fn: async () => {
      const home = mkdtempSync(join(tmpdir(), 'rose-ui-cli-'));
      try {
        for (const file of userUiSeedFiles()) {
          const full = join(home, 'rose_user_ui', file.path);
          mkdirSync(dirname(full), { recursive: true });
          writeFileSync(full, file.content);
        }
        mkdirSync(join(home, 'rose_user_ui', 'node_modules', 'x'), { recursive: true });
        writeFileSync(join(home, 'rose_user_ui', 'node_modules', 'x', 'big.js'), 'skipped');
        writeFileSync(join(home, 'rose_user_ui', '.secret'), 'skipped');
        const cli = join(home, 'rose-ui');
        writeFileSync(cli, userUiCliScript(), { mode: 0o755 });
        const minted = await call('/api/user-ui/publish-token', {
          method: 'POST',
          auth: userA.token,
        });
        expectStatus(minted, 201, 'mint');
        const { stdout } = await execFileAsync(
          process.execPath,
          [cli, 'publish', '--no-activate'],
          {
            env: {
              PATH: process.env.PATH,
              HOME: home,
              ROSE_UI_PUBLISH_URL: `${BASE_URL}/api/user-ui/versions`,
              ROSE_UI_PUBLISH_TOKEN: String(minted.data.token),
            },
          }
        );
        const match = /published version ([0-9a-f-]{36}) \((\d+) files/.exec(stdout);
        assert(match, `cli output: ${stdout}`);
        assert(
          Number(match[2]) === userUiSeedFiles().length,
          `cli skipped dot/node_modules (${match[2]})`
        );
        const list = await call('/api/user-ui/versions', { auth: userA.token });
        const row = (list.data.versions as { versionId: string; active: boolean }[]).find(
          (v) => v.versionId === match[1]
        );
        assert(row && row.active === false, '--no-activate published an inactive version');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'code-session workspace -- seed, local materialize, CLI on PATH, active restore',
    fn: async () => {
      const userC = await anonymousSession();
      assert((await active(userC.token)).versionId === null, 'fresh user has no UI');
      const seed = await prepareUserUiWorkspace(userC.userId);
      assert(seed.source.kind === 'seed', `fresh user gets the seed (${seed.source.kind})`);
      const seedPaths = seed.files.map((f) => f.path).sort();
      for (const required of [
        'rose_user_ui/README.md',
        'rose_user_ui/rose-ui.json',
        'rose_user_ui/root/theme.json',
        'rose_user_ui/examples/inline-hello/index.html',
        'rose_user_ui/examples/shader-background/index.html',
        '.rose/bin/rose-ui',
      ]) {
        assert(seedPaths.includes(required), `seed workspace has ${required}`);
      }
      const readme = seed.files
        .find((f) => f.path === 'rose_user_ui/README.md')!
        .content.toString();
      for (const term of [
        'rose:resize',
        'rose:props',
        'rose:ready',
        'prefers-reduced-motion',
        'devicePixelRatio',
        'rose-ui publish',
      ]) {
        assert(readme.includes(term), `README documents ${term}`);
      }
      assert(seed.envs.ROSE_UI_PUBLISH_URL.endsWith('/api/user-ui/versions'), 'publish url env');
      assert(seed.envs.ROSE_UI_PUBLISH_TOKEN.startsWith('ruip.'), 'publish token env');

      const home = mkdtempSync(join(tmpdir(), 'rose-ui-home-'));
      try {
        const local = await materializeUserUiInLocalHome(home, seed, 'blackbox');
        assert(local, 'local materialize succeeded');
        assert(
          local.envs.ROSE_UI_PUBLISH_URL.endsWith('/api/user-ui/versions'),
          'local publish url'
        );
        const cli = join(local.binDir, 'rose-ui');
        assert((statSync(cli).mode & 0o111) !== 0, 'rose-ui is executable');
        const { stdout } = await execFileAsync(cli, ['publish'], {
          env: {
            PATH: `${local.binDir}:${process.env.PATH ?? ''}`,
            HOME: home,
            ROSE_UI_PUBLISH_URL: `${BASE_URL}/api/user-ui/versions`,
            ROSE_UI_PUBLISH_TOKEN: seed.envs.ROSE_UI_PUBLISH_TOKEN,
          },
        });
        assert(/now active for the user/.test(stdout), `cli output: ${stdout}`);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
      const published = (await active(userC.token)).versionId;
      assert(published !== null, 'session token published for its user');

      const restored = await prepareUserUiWorkspace(userC.userId);
      assert(
        restored.source.kind === 'active' && restored.source.versionId === published,
        'next session restores the active version'
      );
      const restoredA = await prepareUserUiWorkspace(userA.userId);
      assert(restoredA.source.kind === 'active', 'user A restores active version');
      const hello = restoredA.files.find((f) => f.path === 'rose_user_ui/inline/hello/index.html');
      assert(
        hello?.content.toString() === HELLO_HTML,
        'restored file bytes match the published version'
      );
      assert(
        restoredA.files.some((f) => f.path === 'rose_user_ui/README.md'),
        'README regenerated on restore'
      );
    },
  },
  ...userUiExampleCases({
    baseUrl: BASE_URL,
    token: () => userA.token,
    userId: () => userA.userId,
    mintPublishToken: async (auth) => {
      const minted = await call('/api/user-ui/publish-token', { method: 'POST', auth });
      expectStatus(minted, 201, 'mint');
      return String(minted.data.token);
    },
  }),
];

async function main(): Promise<void> {
  userA = await anonymousSession();
  userB = await anonymousSession();
  let failed = 0;
  for (const test of tests) {
    const start = Date.now();
    try {
      await test.fn();
      console.log(`  PASS  ${test.name} (${Date.now() - start}ms)`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${test.name} -- ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    `\nResults: ${tests.length - failed} passed, ${failed} failed, ${tests.length} total`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nCrashed:', err);
  process.exit(1);
});
