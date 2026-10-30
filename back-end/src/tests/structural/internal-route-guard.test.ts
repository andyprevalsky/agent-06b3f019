import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');
const domainsDir = path.join(backendDir, 'src/domains');

// Cements internal-only routes (RCA 2026-10-26-internal-routes-trusted-any-user-jwt).
//
// `authenticate` admits the internal API key OR any Supabase JWT, including
// anonymous sign-ups. Routes that text or call arbitrary numbers, write the
// global DEMO cache, overwrite any run's trace archive, drive any sandbox or
// browser session, or mint code sessions with a body-chosen user (the Codex
// rose harness shipped BACKEND_API_KEY to a caller-chosen URL) were mounted
// with bare `authenticate`, so any signed-in user reached them.
// src/tests/blackbox/route-identity.blackbox.ts proves the 403 over HTTP.
const GUARDS = ['authenticateInternal', 'requireInternal'];

/** Every worker/agent-only route, as `<domain>/<file>` → routes. */
const INTERNAL_ROUTES: Record<string, string[]> = {
  'send-sms/routes.ts': ['/', '/direct', '/notify'],
  'vapi/routes.ts': ['/call', '/call/:id'],
  'demo-cache/routes.ts': ['/get', '/get-many', '/get-position', '/set', '/purge', '/agent-flag'],
  'archive/routes.ts': ['/artifacts', '/artifact'],
  'tool-usage/routes.ts': ['/'],
  'external-http/routes.ts': ['/request'],
  'browser-session/routes.ts': [
    '/close',
    '/:sessionId',
    '/:sessionId/files',
    '/:sessionId/files/list',
    '/:sessionId/inject-localStorage',
  ],
  'claude-code/routes.ts': ['/create', '/close', '/:taskId/output', '/:sandboxId/health'],
  'codex-code/routes.ts': ['/create', '/close', '/:taskId/output', '/:sandboxId/health'],
  'world-models/routes.ts': [
    '/',
    '/world_models',
    '/world_models/:worldModelName/sessions',
    '/world_models/:worldModelName/sessions/:sessionId/step',
  ],
};

/** Text of one route declaration, up to the next `router.<verb>(`. */
function routeBlock(source: string, at: number): string {
  const rest = source.slice(at);
  const next = rest.slice(1).search(/router\.(get|post|put|patch|delete)\s*\(/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Middleware identifiers before the handler, comments removed. */
function middlewareIdentifiers(block: string): string[] {
  const handlerAt = block.search(/asyncHandler\s*(<[^>]*>)?\s*\(|\(\s*req\b/);
  const chain = handlerAt === -1 ? block : block.slice(0, handlerAt);
  const code = chain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

function declarationsOf(source: string, route: string): number[] {
  const literal = new RegExp(
    `router\\.(get|post|put|patch|delete)\\s*\\(\\s*['"\`]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
    'g'
  );
  return [...source.matchAll(literal)].map((m) => m.index!);
}

let guarded = 0;
for (const [rel, routes] of Object.entries(INTERNAL_ROUTES)) {
  const source = fs.readFileSync(path.join(domainsDir, rel), 'utf8');
  for (const route of routes) {
    const declarations = declarationsOf(source, route);
    assert.ok(declarations.length > 0, `${rel}: route '${route}' not found — was it renamed?`);
    for (const at of declarations) {
      const ids = middlewareIdentifiers(routeBlock(source, at));
      assert.ok(
        GUARDS.some((g) => ids.includes(g)),
        `${rel} ${route}: internal-only route must apply ${GUARDS.join(' / ')} — bare ` +
          '`authenticate` admits every signed-in (including anonymous) user.'
      );
      guarded++;
    }
  }
}

// Drift guard: a route documented as internal / worker-only anywhere under
// src/domains must enforce it, either with the guard or an inline
// `req.isInternal` check (refusal, or identity bound to req.user unless internal).
const INTERNAL_DOC =
  /internal[ -]only|internal callers only|API[ -]Key \(internal|\(internal\)|Called by (the )?agent worker|^\s*\*\s*Internal:/im;
const unguarded: string[] = [];
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /^routes.*\.ts$/.test(e.name) ? [p] : [];
  });
}
for (const file of walk(domainsDir)) {
  const source = fs.readFileSync(file, 'utf8');
  const matches = [
    ...source.matchAll(/router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/g),
  ];
  let previousEnd = 0;
  for (const m of matches) {
    const at = m.index!;
    const block = routeBlock(source, at);
    const doc =
      source
        .slice(previousEnd, at)
        .split(/\n\s*\n/)
        .pop() ?? '';
    previousEnd = at + block.length;
    if (!INTERNAL_DOC.test(doc)) continue;
    const ids = middlewareIdentifiers(block);
    if (!ids.includes('authenticate')) continue; // hybrid/HMAC/admin guards own their checks
    if (GUARDS.some((g) => ids.includes(g)) || /req\.isInternal\s*[!=]==\s*true/.test(block))
      continue;
    unguarded.push(`${path.relative(domainsDir, file)} ${m[1].toUpperCase()} ${m[2]}`);
  }
}
assert.deepStrictEqual(
  unguarded,
  [],
  'Routes documented as internal-only are guarded only by `authenticate`; apply ' +
    '`authenticateInternal` (and list them in INTERNAL_ROUTES).'
);

// The Fast Mode proxies carry no Authorization; every trace route must verify
// the server-minted capability (RCA 2026-10-26-internal-routes-trusted-any-user-jwt).
const proxySource = fs.readFileSync(path.join(domainsDir, 'demo-cache/routes.proxy.ts'), 'utf8');
for (const routerName of ['anthropicProxyRouter']) {
  assert.ok(
    new RegExp(`${routerName}\\.use\\(\\s*'/:traceParam',\\s*requireProxyCapability`).test(
      proxySource
    ),
    `${routerName} must verify the proxy capability before any trace route`
  );
}
// Codex never routes through a Rose proxy (S30): no Codex trace router exists.
assert.ok(!proxySource.includes('codexProxyRouter'), 'no Codex proxy router (S30)');
assert.ok(
  !/parse(Anthropic|Codex)TraceParam\(req\.params/.test(proxySource),
  'proxy handlers must parse the verified trace segment, never the raw param'
);

console.log(`✅ internal-route-guard: ${guarded} internal-only route declarations guarded`);
