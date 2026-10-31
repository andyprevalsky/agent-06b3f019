/** R23: replay the recorded Steel /files/screenshot.png carrier, never its image contents. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function load<T>(
  relative: string,
  dependencies: Record<string, unknown>,
  globals: Record<string, unknown> = {}
): T {
  const filename = path.resolve(__dirname, '../..', relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const requireFixture = (name: string): unknown => {
    if (name in dependencies) return dependencies[name];
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === '__esModule') return false;
          return () => {
            throw new Error(`Unexpected dependency ${name}.${String(key)}`);
          };
        },
      }
    );
  };
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    requireFixture,
    module,
    module.exports,
    ...Object.values(globals)
  );
  return module.exports as T;
}

interface FixtureResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): FixtureResponse;
  json(body: unknown): FixtureResponse;
  setHeader(key: string, value: string): void;
  send(body: unknown): FixtureResponse;
}
type Handler = (
  request: {
    params: { sessionId: string };
    query: { path: string };
    user: { id: string };
  },
  response: FixtureResponse
) => Promise<void>;

async function main(): Promise<void> {
  const events: string[] = [];
  let provider = 'steel';
  let owner = 'owner';
  let exists = true;
  let providerStatus = 200;
  let url = '';
  const fixture = Buffer.from('R23 transport fixture; not an image or task evidence');
  const providerValidator = path.resolve(__dirname, '../../providers/browser/sessionFilePath.ts');
  const validator = load<{ validateSessionFilePath(path: string, provider?: string): void }>(
    'domains/browser-session/service.file-path.ts',
    fs.existsSync(providerValidator)
      ? {
          '../../providers/browser/sessionFilePath': load(
            'providers/browser/sessionFilePath.ts',
            {}
          ),
        }
      : {}
  );
  const urls = load<Record<string, unknown>>('providers/steel/urls.ts', {});
  const io = load<{ readSessionFile(sessionId: string, path: string): Promise<Buffer> }>(
    'providers/browser/sessionIo.ts',
    {
      './sessionProvider': {
        providerForSession: async () => {
          events.push('provider');
          return provider;
        },
      },
      './sessionFilePath': validator,
      '../steel/session': urls,
      './kernel': {
        readKernelSessionFile: async () => {
          events.push('kernel-read');
          return fixture;
        },
      },
    },
    {
      fetch: async (input: string) => {
        events.push('read');
        url = input;
        return {
          ok: providerStatus === 200,
          status: providerStatus,
          arrayBuffer: async () => fixture,
        };
      },
    }
  );
  class SessionNotFoundError extends Error {}
  const metadataPath = path.resolve(__dirname, '../../domains/browser-session/service.metadata.ts');
  const metadata = fs.existsSync(metadataPath)
    ? load<Record<string, unknown>>('domains/browser-session/service.metadata.ts', {
        '../../providers/browser/checkpoint': { EMPTY_BROWSER_BASELINE: 'empty-fixture' },
      })
    : {};
  const serviceDependencies = {
    './service.metadata': metadata,
    './repo': {
      findSessionBySessionId: async () => {
        events.push('owner');
        return exists ? { context: { userId: owner } } : null;
      },
    },
    './service.local-storage': { SessionNotFoundError },
    './service.file-path': validator,
    '../../providers/logger': {
      createLogger: () => ({ info() {}, warn() {}, error() {} }),
    },
    '../../providers/browser': { readSessionFile: io.readSessionFile },
  };
  // Main extracted I/O; exercise that actual module through both public paths.
  const sessionIo = load<Record<string, unknown>>(
    'domains/browser-session/service.session-io.ts', serviceDependencies
  );
  const service = load<Record<string, unknown>>('domains/browser-session/service.ts', {
    ...serviceDependencies,
    './service.session-io': sessionIo,
  });
  assert.equal(service.downloadFile, sessionIo.downloadFile);
  await assert.rejects(
    (sessionIo.downloadFile as (session: string, file: string, user: string) => Promise<unknown>)(
      'session', '/files/screenshot.png', 'foreign-user'
    ), SessionNotFoundError
  );
  const buildMetadata = service.buildBrowserSessionMetadata as (
    session: Record<string, unknown>,
    injection: Record<string, unknown>
  ) => Record<string, unknown>;
  const injection = {
    cookies: { injected: true, cookieCount: 2, authSource: 'saved' },
    localStorage: { originCount: 3 },
    indexedDB: { originCount: 4 },
    permissions: { grantCount: 5 },
    cacheStorage: { originCount: 6 },
  };
  for (const name of ['steel', 'kernel', 'tilion']) {
    const metadataSession = {
      provider: name,
      proxySource: 'managed',
      proxyLocation: { country: 'US' },
      profileId: 'profile',
      profileSource: 'saved',
    };
    const expected = {
      provider: name,
      requested_provider: name,
      provider_fallback_reason: null,
      proxy_source: 'managed',
      proxy_location: { country: 'US' },
      profile_id: 'profile',
      profile_source: 'saved',
      auth_source: 'saved',
      cookies_injected: true,
      cookies_count: 2,
      local_storage_origin_count: 3,
      indexed_db_origin_count: 4,
      permission_grant_count: 5,
      cache_storage_origin_count: 6,
      ...(name === 'steel' ? { steel_profile_id: 'profile', steel_profile_source: 'saved' } : {}),
    };
    assert.deepEqual(buildMetadata(metadataSession, injection), expected);
    const geo = {
      requested: true,
      applied: false,
      requestedLocation: { country: 'US' },
      geoApplied: false,
      geoUnsupported: true,
    };
    assert.deepEqual(
      buildMetadata(
        {
          ...metadataSession,
          providerSelection: { requestedProvider: 'kernel', fallbackReason: 'recorded' },
          geoTargeting: geo,
        },
        injection
      ),
      {
        ...expected,
        requested_provider: 'kernel',
        provider_fallback_reason: 'recorded',
        geo_targeting: {
          requested: true,
          applied: false,
          requested_location: { country: 'US' },
          geo_applied: false,
          geo_unsupported: true,
        },
      }
    );
  }
  if (metadata.logicalHasPrivateState) {
    const hasPrivateState = metadata.logicalHasPrivateState as (
      s: Record<string, unknown>
    ) => boolean;
    assert.equal(
      hasPrivateState({ logicalOwnerKey: null, checkpointRef: null, baselineCheckpointRef: null }),
      false
    );
    assert.equal(
      hasPrivateState({
        logicalOwnerKey: 'owner',
        checkpointRef: null,
        baselineCheckpointRef: 'empty-fixture',
      }),
      false
    );
    assert.equal(
      hasPrivateState({
        logicalOwnerKey: 'owner',
        checkpointRef: 'checkpoint',
        baselineCheckpointRef: 'empty-fixture',
      }),
      true
    );
    assert.equal(
      hasPrivateState({
        logicalOwnerKey: 'owner',
        checkpointRef: null,
        baselineCheckpointRef: 'private',
      }),
      true
    );
  }
  const handlers = new Map<string, Handler>();
  const routes = load<{ registerBrowserDataRoutes(router: unknown): void }>(
    'domains/browser-session/routes.files.ts',
    {
      './service': { ...service, SessionNotFoundError },
      '../../providers/auth': { authenticate: () => {} },
      '../../utils/asyncHandler': { asyncHandler: (fn: Handler) => fn },
      '../../providers/browser': {
        BrowserOperationWorkerOwnedError: class extends Error {},
      },
      '../../providers/browser/tilion': {
        TilionInsufficientCreditsError: class extends Error {},
        TilionSessionBusyError: class extends Error {},
      },
    }
  );
  routes.registerBrowserDataRoutes({
    get: (route: string, ...fns: Handler[]) => handlers.set(route, fns[fns.length - 1]),
    post: () => {},
  });
  const handler = handlers.get('/:sessionId/files/content')!;
  async function request(filePath: string, userId = 'owner') {
    events.length = 0;
    const response = {
      statusCode: 200,
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
      setHeader(key: string, value: string) {
        this.headers[key] = value;
      },
      send(body: unknown) {
        this.body = body;
        return this;
      },
    };
    await handler(
      {
        params: { sessionId: 'session/one' },
        query: { path: filePath },
        user: { id: userId },
      },
      response
    );
    return response;
  }
  const oldKey = process.env.STEEL_API_KEY;
  process.env.STEEL_API_KEY = 'offline-fixture-key';
  try {
    const actualPath = '/files/screenshot.png';
    const response = await request(actualPath);
    assert.equal(
      response.statusCode,
      200,
      'recorded Steel carrier was rejected before provider read'
    );
    assert.deepEqual(response.body, fixture);
    assert.deepEqual(events, ['owner', 'provider', 'read']);
    assert.equal(url, 'https://api.steel.dev/v1/sessions/session%2Fone/files/screenshot.png');
    assert.equal(response.headers['Content-Type'], 'application/octet-stream');
    await request('/files/reports/a?b#c.txt');
    assert.equal(
      url,
      'https://api.steel.dev/v1/sessions/session%2Fone/files/reports/a%3Fb%23c.txt'
    );
    for (const invalid of [
      '/etc/passwd',
      '/files/../private',
      '/files\\..\\private',
      '/files/x\0y',
      '/files-other/x',
    ]) {
      assert.equal((await request(invalid)).statusCode, 400, invalid);
      assert.ok(!events.includes('read'), invalid);
    }
    assert.equal((await request('')).statusCode, 400);
    assert.deepEqual(events, [], 'empty path must be rejected by route before any lookup');
    owner = 'someone-else';
    assert.equal((await request(actualPath)).statusCode, 404);
    assert.deepEqual(events, ['owner'], 'wrong owner reached provider lookup');
    owner = 'owner';
    exists = false;
    assert.equal((await request(actualPath)).statusCode, 404);
    assert.deepEqual(events, ['owner']);
    exists = true;
    for (provider of ['kernel', 'tilion', 'browser-use']) {
      assert.equal((await request(actualPath)).statusCode, 400, provider);
      assert.deepEqual(events, ['owner', 'provider']);
    }
    provider = 'steel';
    providerStatus = 404;
    await assert.rejects(request(actualPath), /Steel file read failed: HTTP 404/);
    assert.deepEqual(events, ['owner', 'provider', 'read']);
    providerStatus = 200;
    for (const valid of [
      '/tmp/downloads/list.csv',
      '/tmp/rose-uploads/list.csv',
      '/home/oai/share/list.csv',
      'relative.csv',
    ]) {
      validator.validateSessionFilePath(valid, 'kernel');
      provider = 'kernel';
      assert.deepEqual((await request(valid)).body, fixture);
      assert.deepEqual(events, ['owner', 'provider', 'kernel-read']);
    }
    console.log(
      'PASS R23 recorded Steel carrier, encoded URL, ownership, provider namespace, missing file and unsafe paths'
    );
  } finally {
    if (oldKey === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = oldKey;
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
