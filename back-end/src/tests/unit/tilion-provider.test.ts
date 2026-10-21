#!/usr/bin/env tsx
/**
 * Tilion provider adapter against a fake Tilion server, with the database, CDP
 * validation and Playwright replaced by in-memory fakes.
 *
 * Covers: create contract (ttl/idle/cdp_observe/residential/region/geo,
 * Idempotency-Key), geo city→state fallback, release of a session that fails
 * CDP validation, idempotent release (204/404/410, 503 retried, typed failure),
 * close statuses, resume after Tilion expired the session (410) with carried
 * state, reattach of a live session, mobile rotation, health mapping, live-view
 * token, captcha telemetry shape, REST drive calls, and no `/v1/auth*` call.
 *
 * Module mocks need `--experimental-test-module-mocks` (the unit runner passes it).
 */
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { fakeSessionRecord, FakeTilionServer } from './tilion-fake-server.support';

type Row = Record<string, unknown> & { id: string; sessionId: string };

const rows = new Map<string, Row>();
const announced: unknown[] = [];
let validationFails = 0;
// Exact-cleanup evidence: every created session id must be logged before CDP validation.
const logLines: string[] = [];
const validatedBeforeAllocationLog: string[] = [];
function allocationLogged(sessionId: string): boolean {
  return logLines.some(
    (line) => line.includes('Tilion session allocated') && line.includes(`sessionId=${sessionId}`)
  );
}
let cdpConnects = 0;
const restored: { cookies: unknown[]; scripts: number; visited: string[] } = {
  cookies: [],
  scripts: 0,
  visited: [],
};
let harvestedState = {
  cookies: [
    {
      name: 'sid',
      value: 'carried',
      domain: '.shop.test',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ],
  origins: [{ origin: 'https://shop.test', localStorage: [{ name: 'cart', value: '3' }] }],
};

function fakeBrowser() {
  const page = {
    goto: async (url: string) => {
      restored.visited.push(url);
    },
    evaluate: async () => undefined,
    // Playwright pages always expose frames; the harvest enumerates their origins.
    frames: () => [],
  };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cookies: unknown[]) => {
      restored.cookies.push(...cookies);
    },
    addInitScript: async () => {
      restored.scripts += 1;
    },
    storageState: async () => harvestedState,
  };
  return { contexts: () => [context], close: async () => undefined };
}

/** Prisma leaves a field unchanged when its update value is undefined. */
function assignDefined(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

const prismaFake = {
  browserSession: {
    // Copies, like Prisma: a later update must not mutate a caller's snapshot.
    findUnique: async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      if (!row) throw new Error('row not found');
      return { ...row };
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const row = [...rows.values()].find((r) => matches(r, where));
      if (!row) throw new Error('row not found');
      assignDefined(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      const hits = [...rows.values()].filter((r) => matches(r, where));
      for (const row of hits) assignDefined(row, data);
      return { count: hits.length };
    },
  },
  agent: {
    findUnique: async () => ({ proxyCountry: 'US', proxyState: 'TX', proxyCity: 'DALLAS' }),
  },
  // pausedBrowserState statements from tilionState.ts, recognised by their SQL text.
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('"pausedBrowserState" = ?::jsonb')) {
      const hits = [...rows.values()].filter((r) => r.sessionId === values[1]);
      for (const row of hits) row.pausedBrowserState = JSON.parse(String(values[0]));
      return hits.length;
    }
    const key = sql.includes('"id" = ?') ? 'id' : 'sessionId';
    const hits = [...rows.values()].filter((r) => r[key] === values[0]);
    for (const row of hits) row.pausedBrowserState = null;
    return hits.length;
  },
  $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const row = [...rows.values()].find((r) => r.id === values[0] && r.sessionId === values[1]);
    return row ? [{ state: row.pausedBrowserState ?? null }] : [];
  },
};

async function main(): Promise<void> {
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logLines.push(String(chunk));
    return (writeOut as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  await mock.module('../../providers/database', { namedExports: { prisma: prismaFake } });
  await mock.module('../../providers/steel/sessionConnection', {
    namedExports: {
      connectValidatedBrowser: async (wsUrl: string) => {
        const sessionId =
          /\/session\/([^/]+)\//.exec(wsUrl)?.[1] ?? /\/(sess_[^/]+)\//.exec(wsUrl)?.[1];
        if (sessionId && !allocationLogged(sessionId)) validatedBeforeAllocationLog.push(sessionId);
        if (validationFails > 0) {
          validationFails -= 1;
          return null;
        }
        return fakeBrowser();
      },
    },
  });
  await mock.module('../../providers/browser/sessionBindingAnnounce', {
    namedExports: {
      announceBrowserSessionBinding: async (where: unknown) => {
        announced.push(where);
      },
    },
  });
  await mock.module('../../providers/browser/sessionPersist', {
    namedExports: {
      persistBrowserSessionRow: async (input: Row & { taskId?: string }) => {
        const id = input.taskId ?? `task-${rows.size + 1}`;
        const row: Row = { ...input, id, status: 'ACTIVE', closedAt: null, proxyRotationCount: 0 };
        rows.set(id, row);
        return row;
      },
    },
  });
  await mock.module('playwright', {
    namedExports: {
      chromium: {
        connectOverCDP: async () => {
          cdpConnects += 1;
          return fakeBrowser();
        },
      },
    },
  });

  const server = new FakeTilionServer();
  await server.start();
  const envKeys = [
    'TILION_API_KEY',
    'TILION_BASE_URL',
    'TILION_SESSION_TTL_SECONDS',
    'TILION_IDLE_TIMEOUT_SECONDS',
    'TILION_CDP_OBSERVE',
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.TILION_API_KEY = 'ph_live_provider_test';
  process.env.TILION_BASE_URL = server.baseUrl;
  delete process.env.TILION_SESSION_TTL_SECONDS;
  delete process.env.TILION_IDLE_TIMEOUT_SECONDS;
  delete process.env.TILION_CDP_OBSERVE;

  let created = 0;
  const live = new Set<string>();
  const ended = new Set<string>();
  let deleteStatus: number[] = [];
  const standardRoutes = () => {
    server.route('GET', /^\/v1\/regions$/, () => ({
      status: 200,
      body: [{ code: 'us' }, { code: 'de' }, { code: 'sg' }],
    }));
    server.route('POST', /^\/v1\/session$/, (request) => {
      created += 1;
      const id = `sess_${String(created).padStart(32, '0')}`;
      live.add(id);
      const geo = (request.body as { geo?: { country?: string } }).geo;
      return {
        status: 201,
        body: fakeSessionRecord(
          id,
          geo?.country === 'de' ? { geo_applied: false, geo_unsupported: ['country'] } : {}
        ),
      };
    });
    server.route('DELETE', /^\/v1\/session\/[^/]+$/, (request) => {
      const id = request.path.split('/').pop()!;
      const status = deleteStatus.shift() ?? 204;
      if (status === 204) {
        live.delete(id);
        ended.add(id);
      }
      return { status, body: status === 204 ? undefined : { detail: 'retry cleanup' } };
    });
    server.route('POST', /\/view-token$/, (request) => {
      const id = request.path.split('/')[3];
      return ended.has(id)
        ? { status: 410, body: { detail: { state: 'closed' } } }
        : {
            status: 200,
            body: {
              token: 'view-secret',
              expires_in: 1800,
              live_view_url: `/v1/session/${id}/live-view?token=view-secret-${created}`,
            },
          };
    });
    server.route('GET', /\/connect$/, (request) => {
      const id = request.path.split('/')[3];
      return live.has(id)
        ? {
            status: 200,
            body: {
              session_id: id,
              connect_url: `wss://tilion.invalid/${id}/cdp?token=fresh`,
              expires_in: 1800,
            },
          }
        : { status: 410, body: { detail: { state: 'expired', reason: 'idle_expired' } } };
    });
    server.route('GET', /\/status$/, (request) => {
      const id = request.path.split('/')[3];
      return {
        status: 200,
        body: live.has(id)
          ? fakeSessionRecord(id, { connect_url: null })
          : {
              session_id: id,
              state: 'expired',
              reason: 'idle_expired',
              created_at: 1,
              closed_at: 2,
              ttl: 3600,
            },
      };
    });
    server.route('GET', /\/context$/, () => ({
      status: 410,
      body: { detail: { state: 'expired' } },
    }));
  };

  try {
    const tilion = await import('../../providers/browser/tilion');
    standardRoutes();

    // ── B1/B2/G1: create contract, idempotency key, country-only placement ──
    const session = await tilion.createTilionSessionWithContext(
      'ctx-1',
      'agent-1',
      { country: 'US', state: 'TX', city: 'DALLAS' },
      'https://shop.test/start',
      { taskId: 'task-a' }
    );
    const creates = server.callsTo('POST', /^\/v1\/session$/);
    assert.equal(creates.length, 1, 'a city-targeted agent must cost exactly one create');
    const first = creates[0].body as Record<string, unknown>;
    assert.equal(first.ttl, 14_400);
    assert(Number(first.ttl) >= tilion.TILION_MIN_TTL_SECONDS);
    assert.equal(first.idle_timeout, 3600);
    assert.equal(first.cdp_observe, false);
    assert.equal(first.residential, true);
    assert.equal(first.proxy_type, 'residential');
    assert.equal(first.region, 'us');
    assert.deepEqual(first.geo, { country: 'us' }, 'Tilion honours only the country');
    assert.match(String(creates[0].headers['idempotency-key']), /^rose-/);
    assert.equal(server.callsTo('DELETE', /^\/v1\/session\//).length, 0, 'no wasted create');
    // The narrower targeting gap stays visible (issue T2).
    assert.deepEqual(session.geoTargeting, {
      requested: 'city',
      applied: 'country',
      requestedLocation: { country: 'US', state: 'TX', city: 'DALLAS' },
      geoApplied: true,
      geoUnsupported: [],
    });
    assert.equal(session.provider, 'tilion');
    assert.equal(session.proxySource, 'tilion_residential_country');
    assert.deepEqual(session.proxyLocation, { country: 'US' });
    assert.equal(
      session.validationBrowser,
      null,
      'validation client must be closed (single CDP client)'
    );
    assert.match(session.debugUrl, /\/live-view\?token=/);
    assert.equal(rows.get('task-a')?.provider, 'tilion');
    assert.equal(rows.get('task-a')?.kernelProxySource, 'tilion_residential_country');
    assert.equal(rows.get('task-a')?.proxyTier, 'residential', 'create records the exit tier');

    // A state-targeted agent also costs one create; the gap is recorded.
    const createsBefore = server.callsTo('POST', /^\/v1\/session$/).length;
    const stateTargeted = await tilion.createTilionSessionWithContext(
      'ctx-1',
      'agent-1',
      { country: 'US', state: 'TX' },
      undefined,
      { taskId: 'task-country' }
    );
    assert.equal(server.callsTo('POST', /^\/v1\/session$/).length, createsBefore + 1);
    assert.deepEqual(server.callsTo('POST', /^\/v1\/session$/).at(-1)!.body, {
      ...first,
      geo: { country: 'us' },
    });
    assert.equal(stateTargeted.geoTargeting.requested, 'state');
    assert.equal(stateTargeted.geoTargeting.applied, 'country');
    await tilion.releaseTilionRemoteSession(stateTargeted.sessionId);

    // keepValidationConnection hands the only client to the caller
    const kept = await tilion.createTilionSessionWithContext(
      'ctx-1',
      'agent-1',
      { country: 'DE' },
      undefined,
      {
        taskId: 'task-kept',
        keepValidationConnection: true,
      }
    );
    assert.notEqual(kept.validationBrowser, null);
    const deCreate = server.callsTo('POST', /^\/v1\/session$/).at(-1)!.body as Record<
      string,
      unknown
    >;
    // Tilion's own refusal is recorded, not hidden.
    assert.equal(kept.geoTargeting.geoApplied, false);
    assert.deepEqual(kept.geoTargeting.geoUnsupported, ['country']);
    assert.equal(deCreate.region, 'de');

    // ── B1: CDP validation failure releases the paid session ────────────────
    validationFails = 2;
    const failed = await tilion
      .createTilionSessionWithContext('ctx-1', 'agent-1', { country: 'US' }, undefined, {
        taskId: 'task-f',
      })
      .catch((e) => e);
    assert(failed instanceof Error);
    assert.match(failed.message, /failed CDP validation/);
    assert.equal(rows.has('task-f'), false);
    assert.equal(live.size, 2, 'failed validation sessions must be released');

    // ── B4/B5: release idempotency ──────────────────────────────────────────
    for (const status of [404, 410]) {
      deleteStatus = [status];
      await tilion.releaseTilionRemoteSession(`sess_gone_${status}`);
    }
    deleteStatus = [503, 204];
    live.add('sess_flaky');
    await tilion.releaseTilionRemoteSession('sess_flaky');
    assert.equal(live.has('sess_flaky'), false);
    deleteStatus = [503, 503, 503, 503];
    const stuck = await tilion.releaseTilionRemoteSession('sess_stuck').catch((e) => e);
    assert(stuck instanceof tilion.TilionSessionReleaseError);
    assert.equal(server.callsTo('DELETE', /sess_stuck$/).length, 4);
    deleteStatus = [];

    // ── health / live view / telemetry / drive calls ────────────────────────
    const health = await tilion.getTilionSessionHealth(session.sessionId);
    assert.equal(health.provider, 'tilion');
    assert.equal(health.status, 'ready');
    assert.equal(health.timeoutMs, 3_600_000, 'health reads the ttl Tilion reports');
    assert(health.ttlMs !== null && health.ttlMs > 0 && health.ttlMs <= 600_000);
    const liveUrl = await tilion.getTilionLiveViewUrl(session.sessionId);
    assert(
      liveUrl.startsWith(`${server.baseUrl}/v1/session/${session.sessionId}/live-view?token=`)
    );
    assert.equal(rows.get('task-a')?.debugUrl, liveUrl);
    const telemetry = await tilion.getTilionCaptchaTelemetry(session.sessionId);
    assert.deepEqual(telemetry, {
      provider: 'tilion',
      telemetryEnabled: false,
      isSolving: null,
      activeTaskCount: null,
      pages: [],
      latestOutcome: null,
    });
    server.route('POST', /\/screenshot$/, () => ({
      status: 200,
      body: { ok: true, image_base64: Buffer.from('png-bytes').toString('base64') },
    }));
    server.route('POST', /\/act$/, () => ({
      status: 200,
      body: { ok: true, action: 'press', error: null },
    }));
    server.route('POST', /\/files\/fetch$/, () => ({
      status: 200,
      body: { size: 3, content_base64: Buffer.from('abc').toString('base64') },
    }));
    // rotate-ip answers in turn from this queue (fresh exit, stale exit, refusal).
    const rotateReplies: Array<{ status: number; body: unknown }> = [];
    server.route('POST', /\/rotate-ip$/, () => rotateReplies.shift() ?? { status: 500, body: {} });
    server.route('GET', /^\/v1\/sessions$/, () => ({
      status: 200,
      body: [fakeSessionRecord('sess_a'), fakeSessionRecord('sess_b')],
    }));
    assert.equal((await tilion.captureTilionScreenshot(session.sessionId)).toString(), 'png-bytes');
    await tilion.pressTilionKeys(session.sessionId, ['Control', 'v']);
    assert.deepEqual(server.callsTo('POST', /\/act$/).at(-1)!.body, {
      action: 'press',
      key: 'Control+v',
    });
    const fileUrl = 'https://shop.test/invoice.pdf';
    assert.equal(
      (await tilion.readTilionSessionFile(session.sessionId, fileUrl)).toString(),
      'abc'
    );
    // Downloads are listed from the worker's ledger, not from backend memory.
    assert.deepEqual(await tilion.listTilionSessionFiles(session.sessionId), []);
    await assert.rejects(
      tilion.readTilionSessionFile(session.sessionId, '/tmp/downloads/x'),
      /download URL/
    );
    assert.deepEqual(await tilion.listLiveTilionSessionIds(), ['sess_a', 'sess_b']);

    // ── B8: resume of a still-live session reattaches in place ──────────────
    const reattached = await tilion.resumeTilionSession('task-a');
    assert.equal(reattached.sessionId, session.sessionId);
    assert.equal(reattached.previousSessionId, session.sessionId);
    assert.equal(reattached.wsUrl, `wss://tilion.invalid/${session.sessionId}/cdp?token=fresh`);
    assert.equal(rows.get('task-a')?.wsUrl, reattached.wsUrl);

    // ── close: pause snapshots state, releases, PAUSED ──────────────────────
    rows.get('task-a')!.currentUrl = 'https://shop.test/cart';
    await tilion.closeTilionSession(session.sessionId, true);
    assert.equal(rows.get('task-a')?.status, 'PAUSED');
    assert.notEqual(
      rows.get('task-a')?.pausedBrowserState ?? null,
      null,
      'pause stores state on the row'
    );
    assert.equal(live.has(session.sessionId), false);

    // ── B7: resume after the session ended carries state + URL ──────────────
    restored.cookies.length = 0;
    restored.visited.length = 0;
    const resumed = await tilion.resumeTilionSession('task-a', { keepValidationConnection: true });
    assert.notEqual(resumed.sessionId, session.sessionId);
    assert.equal(resumed.previousSessionId, session.sessionId);
    assert.equal(resumed.previousProvider, 'tilion');
    assert.equal(resumed.savedUrl, 'https://shop.test/cart');
    assert.equal(resumed.profileSource, 'tilion_carried_state');
    assert(resumed.validationBrowser, 'resume keeps the validation client for injection');
    assert.equal((restored.cookies[0] as { value: string }).value, 'carried');
    assert.deepEqual(restored.visited, ['https://shop.test', 'https://shop.test/cart']);
    assert.equal(rows.get('task-a')?.sessionId, resumed.sessionId);
    assert.equal(rows.get('task-a')?.status, 'ACTIVE');
    assert.equal(rows.get('task-a')?.pausedBrowserState, null, 'consumed snapshot cleared');
    assert(announced.some((w) => JSON.stringify(w) === JSON.stringify({ id: 'task-a' })));

    // Tilion expired the ACTIVE session itself (idle/ttl): resume still works.
    live.delete(resumed.sessionId);
    ended.add(resumed.sessionId);
    const afterExpiry = await tilion.resumeTilionSession('task-a');
    assert.notEqual(afterExpiry.sessionId, resumed.sessionId);
    assert.equal(afterExpiry.previousSessionId, resumed.sessionId);

    // ── rotation to mobile: replacement with proxy_type mobile, tier persisted ──
    // Single CDP client: a live Tilion session is never connected mid-run; the
    // worker's captured state is carried instead.
    const connectsBeforeRotation = cdpConnects;
    restored.cookies.length = 0;
    const rotated = await tilion.rotateTilionSession('task-a', 'mobile', {
      carriedState: {
        cookies: [{ ...harvestedState.cookies[0], value: 'from-worker' }],
        origins: [],
      },
    });
    assert.equal(
      cdpConnects,
      connectsBeforeRotation,
      'backend opened CDP on a live Tilion session'
    );
    assert.equal((restored.cookies[0] as { value: string }).value, 'from-worker');
    const mobileCreate = server.callsTo('POST', /^\/v1\/session$/).at(-1)!.body as Record<
      string,
      unknown
    >;
    assert.equal(mobileCreate.proxy_type, 'mobile');
    assert.equal(
      (mobileCreate.geo as { city?: string }).city,
      undefined,
      'rotation drops the city'
    );
    assert.equal(rotated.previousSessionId, afterExpiry.sessionId);
    assert.equal(rows.get('task-a')?.proxyTier, 'mobile');
    assert.match(rotated.proxySource, /^tilion_mobile_/);
    await assert.rejects(tilion.rotateTilionSession('task-a', 'isp'), /no isp exit/);

    // ── direct (datacenter) exit: residential egress refuses payment hosts ──
    const lastCreate = () =>
      server.callsTo('POST', /^\/v1\/session$/).at(-1)!.body as Record<string, unknown>;
    const direct = await tilion.createTilionSessionWithContext(
      'ctx-1',
      'agent-1',
      { country: 'US', state: 'TX', city: 'DALLAS' },
      'https://checkout.test/pay',
      { taskId: 'task-direct', proxyType: 'direct' }
    );
    const directBody = lastCreate();
    assert.equal(directBody.residential, false);
    assert.equal('proxy_type' in directBody, false, 'direct sends no proxy_type');
    assert.equal('geo' in directBody, false, 'direct sends no exit geo');
    assert.equal(directBody.region, 'us');
    assert.equal(direct.proxySource, 'tilion_direct_country');
    assert.equal(direct.geoTargeting.geoApplied, null);
    assert.equal(rows.get('task-direct')?.proxyTier, 'direct');
    assert.equal(rows.get('task-direct')?.kernelProxySource, 'tilion_direct_country');
    const directCandidate = await tilion.createTilionRecoverySession(
      { country: 'US' },
      { proxyType: 'direct' }
    );
    assert.equal(lastCreate().residential, false);
    assert.equal(directCandidate.proxySource, 'tilion_direct_country');
    await tilion.releaseTilionRemoteSession(directCandidate.sessionId);
    // A paused direct session resumes on a direct exit again.
    await tilion.closeTilionSession(direct.sessionId, true);
    const directResumed = await tilion.resumeTilionSession('task-direct');
    assert.equal(lastCreate().residential, false);
    assert.equal(directResumed.proxySource, 'tilion_direct_country');
    assert.equal(rows.get('task-direct')?.proxyTier, 'direct');
    await tilion.closeTilionSession(directResumed.sessionId, false);

    // ── B: a live Tilion session is never swapped for a blank browser ──────
    rotateReplies.push({
      status: 409,
      body: { detail: { error: 'residential_rotation_unavailable', message: 'none' } },
    });
    await assert.rejects(
      tilion.rotateTilionSession('task-a', 'residential'),
      (error: unknown) => error instanceof tilion.TilionUncarriedStateError
    );
    assert.equal(rows.get('task-a')?.sessionId, rotated.sessionId, 'fail closed keeps the binding');
    await assert.rejects(
      tilion.rotateTilionSession('task-a', 'mobile'),
      tilion.TilionUncarriedStateError
    );

    // ── G2: residential rotate-ip in place when Tilion allocates a fresh exit ──
    rotateReplies.push({
      status: 200,
      body: {
        session_id: rotated.sessionId,
        rotated: true,
        region: 'us-east-1',
        fresh_allocation: true,
      },
    });
    const inPlace = await tilion.rotateTilionSession('task-a', 'residential');
    assert.equal(inPlace.sessionId, rotated.sessionId);
    assert.equal(inPlace.previousSessionId, rotated.sessionId, 'in place: caller must not release');
    assert.deepEqual(inPlace.ipRotation, {
      rotated: true,
      freshAllocation: true,
      region: 'us-east-1',
    });
    assert.equal(rows.get('task-a')?.proxyTier, 'residential');
    assert.equal(rows.get('task-a')?.kernelProxySource, 'tilion_residential_rotated_us-east-1');
    assert.equal(live.has(rotated.sessionId), true, 'in-place rotation keeps the session');

    // fresh_allocation false is no proof: replacement with the worker's state.
    rotateReplies.push({
      status: 200,
      body: {
        session_id: rotated.sessionId,
        rotated: true,
        region: 'us-east-1',
        fresh_allocation: false,
      },
    });
    restored.cookies.length = 0;
    const unproven = await tilion.rotateTilionSession('task-a', 'residential', {
      carriedState: { cookies: [{ ...harvestedState.cookies[0], value: 'worker-2' }], origins: [] },
    });
    assert.notEqual(
      unproven.sessionId,
      rotated.sessionId,
      'stale exit must fall back to replacement'
    );
    assert.equal(unproven.previousSessionId, rotated.sessionId);
    assert.equal(unproven.ipRotation, undefined);
    assert.equal((restored.cookies[0] as { value: string }).value, 'worker-2');
    assert.equal(server.callsTo('POST', /\/rotate-ip$/).length, 3);
    const finalSessionId = unproven.sessionId;

    // ── close failure keeps the row retryable ───────────────────────────────
    deleteStatus = [503, 503, 503, 503];
    await assert.rejects(
      tilion.closeTilionSession(finalSessionId, false),
      /release was not confirmed/
    );
    assert.equal(rows.get('task-a')?.status, 'ERROR');
    deleteStatus = [];
    await tilion.closeTilionSession(finalSessionId, false);
    assert.equal(rows.get('task-a')?.status, 'CLOSED');

    // ── lifetime config fails loudly below the activity budget + 5 min ──────
    process.env.TILION_SESSION_TTL_SECONDS = '1800';
    assert.throws(() => tilion.tilionSessionLifetime(), /TILION_SESSION_TTL_SECONDS/);
    delete process.env.TILION_SESSION_TTL_SECONDS;

    // ── every create logged its id before validation, including failed ones ──
    assert.deepEqual(
      validatedBeforeAllocationLog,
      [],
      'CDP validation ran before the id was logged'
    );
    const allocated = logLines.filter((line) => line.includes('Tilion session allocated')).length;
    assert.equal(allocated, server.callsTo('POST', /^\/v1\/session$/).length);
    assert(
      allocationLogged('sess_' + '0'.repeat(31) + '4'),
      'a session that failed validation was not logged'
    );

    // ── never the account-wide saved logins ─────────────────────────────────
    assert.equal(server.requests.filter((r) => r.path.startsWith('/v1/auth')).length, 0);
    harvestedState = { cookies: [], origins: [] };
  } finally {
    await server.stop();
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
  process.stdout.write('tilion-provider: all assertions passed\n');
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  );
  process.exit(1);
});
