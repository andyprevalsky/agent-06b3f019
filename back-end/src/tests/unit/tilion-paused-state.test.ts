#!/usr/bin/env tsx
/**
 * Paused Tilion browser state is durable: a pause in one backend process and
 * the resume in ANOTHER process (no shared memory) restore the same cookies,
 * localStorage and IndexedDB, and the stored snapshot is cleared once consumed.
 *
 * parent: fake Tilion server + DB file ──spawn──▶ child "pause"  (closeTilionSession pause)
 *                                      ──spawn──▶ child "resume" (resumeTilionSession)
 * Each child replaces the database with a fake that reads/writes that JSON file,
 * so the only path between them is the BrowserSession row.
 *
 * Module mocks need `--experimental-test-module-mocks` (the unit runner passes it).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fakeSessionRecord, FakeTilionServer } from './tilion-fake-server.support';

type Row = Record<string, unknown> & { id: string; sessionId: string };

const PAUSED_STATE = {
  cookies: [
    {
      name: 'cart_sid',
      value: 'not-signed-in-cart',
      domain: '.shop.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
    },
  ],
  origins: [
    {
      origin: 'https://shop.test',
      localStorage: [{ name: 'cart', value: '3 items' }],
      indexedDB: [{ name: 'offline', version: 1, stores: [] }],
    },
  ],
};

function fileDatabase(dbFile: string) {
  const load = (): Record<string, Row> => JSON.parse(readFileSync(dbFile, 'utf8'));
  const save = (rows: Record<string, Row>) => writeFileSync(dbFile, JSON.stringify(rows));
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const assignDefined = (row: Row, data: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
  };
  return {
    browserSession: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const row = Object.values(load()).find((r) => matches(r, where));
        return row ? { ...row } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const row = Object.values(load()).find((r) => matches(r, where));
        if (!row) throw new Error('row not found');
        return { ...row };
      },
      update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const rows = load();
        const row = Object.values(rows).find((r) => matches(r, where));
        if (!row) throw new Error('row not found');
        assignDefined(row, data);
        save(rows);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
        const rows = load();
        const hits = Object.values(rows).filter((r) => matches(r, where));
        for (const row of hits) assignDefined(row, data);
        save(rows);
        return { count: hits.length };
      },
    },
    agent: { findUnique: async () => ({ proxyCountry: 'US', proxyState: null, proxyCity: null }) },
    // The three statements tilionState.ts issues, recognised by their SQL text.
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const rows = load();
      let hits: Row[];
      if (sql.includes('"pausedBrowserState" = ?::jsonb')) {
        const [json, sessionId] = values as [string, string];
        hits = Object.values(rows).filter((r) => r.sessionId === sessionId);
        for (const row of hits) row.pausedBrowserState = JSON.parse(json);
      } else if (sql.includes('"pausedBrowserState" = NULL')) {
        const key = sql.includes('"id" = ?') ? 'id' : 'sessionId';
        hits = Object.values(rows).filter(
          (r) =>
            r[key] === values[0] &&
            r.pausedBrowserState !== null &&
            r.pausedBrowserState !== undefined
        );
        for (const row of hits) row.pausedBrowserState = null;
      } else {
        throw new Error(`unexpected SQL: ${sql}`);
      }
      save(rows);
      return hits.length;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      if (!sql.includes('SELECT "pausedBrowserState" AS state')) {
        throw new Error(`unexpected SQL: ${sql}`);
      }
      const [id, sessionId] = values;
      const row = Object.values(load()).find((r) => r.id === id && r.sessionId === sessionId);
      return row ? [{ state: row.pausedBrowserState ?? null }] : [];
    },
  };
}

async function child(phase: string, dbFile: string, reportFile: string): Promise<void> {
  const report: Record<string, unknown> = { cookies: [], scripts: [], visited: [], cdpConnects: 0 };
  const fakeBrowser = () => {
    const page = {
      goto: async (url: string) => (report.visited as string[]).push(url),
      evaluate: async () => undefined,
    };
    const context = {
      pages: () => [page],
      newPage: async () => page,
      addCookies: async (cookies: unknown[]) => (report.cookies as unknown[]).push(...cookies),
      addInitScript: async (script: string) => (report.scripts as string[]).push(script),
      storageState: async () => PAUSED_STATE,
    };
    return { contexts: () => [context], close: async () => undefined };
  };
  await mock.module('../../providers/database', {
    namedExports: { prisma: fileDatabase(dbFile) },
  });
  await mock.module('../../providers/steel/sessionConnection', {
    namedExports: { connectValidatedBrowser: async () => fakeBrowser() },
  });
  await mock.module('../../providers/browser/sessionBindingAnnounce', {
    namedExports: { announceBrowserSessionBinding: async () => undefined },
  });
  await mock.module('playwright', {
    namedExports: {
      chromium: {
        connectOverCDP: async () => {
          report.cdpConnects = Number(report.cdpConnects) + 1;
          return fakeBrowser();
        },
      },
    },
  });
  const tilion = await import('../../providers/browser/tilion');
  if (phase === 'pause') {
    await tilion.closeTilionSession('sess_paused', true);
  } else {
    const resumed = await tilion.resumeTilionSession('task-p', { keepValidationConnection: true });
    report.resumed = {
      sessionId: resumed.sessionId,
      previousSessionId: resumed.previousSessionId,
      profileSource: resumed.profileSource,
      savedUrl: resumed.savedUrl,
    };
  }
  writeFileSync(reportFile, JSON.stringify(report));
}

async function runChild(phase: string, dbFile: string, reportFile: string, baseUrl: string) {
  // Async spawn: the fake Tilion server answers from this process's event loop.
  const child = spawn(
    process.execPath,
    ['--experimental-test-module-mocks', '--import', 'tsx', __filename, phase, dbFile, reportFile],
    {
      env: {
        ...process.env,
        TILION_API_KEY: 'ph_live_paused_state_test',
        TILION_BASE_URL: baseUrl,
      },
    }
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  assert.equal(status, 0, `${phase} child failed:\n${output}`);
  return JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>;
}

async function parent(): Promise<void> {
  // ── size bound: IndexedDB goes first, then localStorage, cookies last ────
  const { boundPausedState, PAUSED_STATE_MAX_BYTES } =
    await import('../../providers/browser/tilionState');
  assert.equal(boundPausedState(PAUSED_STATE), PAUSED_STATE);
  const huge = 'x'.repeat(PAUSED_STATE_MAX_BYTES);
  const withHugeIdb = {
    ...PAUSED_STATE,
    origins: [{ ...PAUSED_STATE.origins[0], indexedDB: [{ name: huge, version: 1, stores: [] }] }],
  };
  assert.deepEqual(boundPausedState(withHugeIdb)?.origins, [
    { origin: 'https://shop.test', localStorage: [{ name: 'cart', value: '3 items' }] },
  ]);
  const withHugeLocal = {
    ...PAUSED_STATE,
    origins: [{ origin: 'https://shop.test', localStorage: [{ name: 'big', value: huge }] }],
  };
  assert.deepEqual(boundPausedState(withHugeLocal)?.origins, []);
  assert.equal(
    boundPausedState({ cookies: [{ ...PAUSED_STATE.cookies[0], value: huge }], origins: [] }),
    null
  );

  // ── pause in one process, resume in another ─────────────────────────────
  const server = new FakeTilionServer();
  await server.start();
  const dir = mkdtempSync(join(tmpdir(), 'tilion-paused-state-'));
  const dbFile = join(dir, 'db.json');
  const live = new Set(['sess_paused']);
  let created = 0;
  server
    .route('GET', /^\/v1\/regions$/, () => ({ status: 200, body: [{ code: 'us' }] }))
    .route('GET', /\/connect$/, (request) => {
      const id = request.path.split('/')[3];
      return live.has(id)
        ? { status: 200, body: { connect_url: `wss://tilion.invalid/${id}/cdp?token=t` } }
        : { status: 410, body: { detail: { state: 'closed' } } };
    })
    .route('DELETE', /^\/v1\/session\/[^/]+$/, (request) => {
      live.delete(request.path.split('/').pop()!);
      return { status: 204 };
    })
    .route('POST', /^\/v1\/session$/, () => {
      created += 1;
      const id = `sess_resumed_${created}`;
      live.add(id);
      return { status: 201, body: fakeSessionRecord(id) };
    })
    .route('POST', /\/view-token$/, (request) => ({
      status: 200,
      body: { live_view_url: `/v1/session/${request.path.split('/')[3]}/live-view?token=v` },
    }));
  writeFileSync(
    dbFile,
    JSON.stringify({
      'task-p': {
        id: 'task-p',
        agentId: 'agent-p',
        contextId: 'ctx-p',
        sessionId: 'sess_paused',
        provider: 'tilion',
        status: 'ACTIVE',
        currentUrl: 'https://shop.test/cart',
        startUrl: 'https://shop.test/',
        wsUrl: 'wss://tilion.invalid/sess_paused/cdp?token=old',
        debugUrl: 'https://tilion.invalid/live',
        proxyTier: null,
        proxyRotationCount: 0,
        kernelProxySource: 'tilion_residential_country',
        pausedBrowserState: null,
      },
    })
  );
  try {
    await runChild('pause', dbFile, join(dir, 'pause.json'), server.baseUrl);
    const paused = JSON.parse(readFileSync(dbFile, 'utf8'))['task-p'] as Row;
    assert.equal(paused.status, 'PAUSED');
    assert.deepEqual(
      paused.pausedBrowserState,
      PAUSED_STATE,
      'pause must store the snapshot on the row'
    );
    assert.equal(live.has('sess_paused'), false, 'pause must release the paid session');

    const report = await runChild('resume', dbFile, join(dir, 'resume.json'), server.baseUrl);
    const resumed = report.resumed as Record<string, unknown>;
    assert.equal(resumed.previousSessionId, 'sess_paused');
    assert.equal(resumed.sessionId, 'sess_resumed_1');
    assert.equal(resumed.profileSource, 'tilion_carried_state');
    assert.equal(resumed.savedUrl, 'https://shop.test/cart');
    assert.deepEqual(report.cookies, PAUSED_STATE.cookies, 'cookies restored in a fresh process');
    const scripts = report.scripts as string[];
    assert.equal(scripts.length, 1);
    assert.match(scripts[0], /"cart"/, 'localStorage restore script missing');
    assert.match(scripts[0], /"offline"/, 'IndexedDB restore script missing');
    assert.deepEqual(report.visited, ['https://shop.test', 'https://shop.test/cart']);

    const after = JSON.parse(readFileSync(dbFile, 'utf8'))['task-p'] as Row;
    assert.equal(after.sessionId, 'sess_resumed_1');
    assert.equal(after.status, 'ACTIVE');
    assert.equal(after.pausedBrowserState, null, 'a consumed snapshot must be cleared');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write('tilion-paused-state: all assertions passed\n');
}

const [phase, dbFile, reportFile] = process.argv.slice(2);
(phase ? child(phase, dbFile, reportFile) : parent()).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
