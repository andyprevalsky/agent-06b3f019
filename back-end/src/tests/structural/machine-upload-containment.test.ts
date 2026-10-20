import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, '../../..');
const domainsDir = path.join(backendDir, 'src/domains');

// Cements impersonation containment on machine-data ingest.
//
// These routes store data harvested from the CALLER'S OWN device against
// whatever account the session names. While an admin impersonates, that account
// is the target user, so a route guarded by bare `authenticate` writes the
// operator's cookies, passwords, message history and provider credentials into
// someone else's account — silent cross-account corruption no later fix can
// un-write (prod, 2026-08-04: ~15k cookies and 552 browser passwords from one
// operator's Mac landed in another user's account).
//
// The desktop client refuses these syncs too, but a client-side guard is only as
// good as the installed build — that check shipped in mac-app v1.1.124 while
// v1.1.121 was still in the field and still leaking. The boundary that performs
// the write owns the invariant.
const GUARDS = ['authenticateMachineUpload', 'rejectImpersonatedUpload'];

/**
 * Every route that ingests caller-machine data, as `<domain>/<file>` → routes.
 *
 * `/queue/pop` and `/queue/:id/result` are here because the mac-app claiming a
 * queued message registers THIS machine as the account's iMessage bridge and
 * sends from it — an operator's Mac must never do that for a viewed user.
 */
const MACHINE_DATA_ROUTES: Record<string, string[]> = {
  'integrations/routes.browser.ts': [
    '/cookies/upload',
    '/localStorage/upload',
    '/indexedDB/upload',
    '/fingerprint/upload',
    '/permissions/upload',
    '/cacheStorage/upload',
    '/passwords/upload',
  ],
  'integrations/routes.upload.ts': [
    '/upload',
    '/contacts/upload',
    '/email/upload',
    '/imessage/upload',
    '/whatsapp/upload',
    '/telegram/upload',
    '/telegram/connect',
    '/passwords/apple/upload',
  ],
  'integrations/routes.claude.ts': [
    '/claude-code/credentials/upload',
    '/gpt-code/credentials/upload',
  ],
  'integrations/routes.passkeys.ts': ['/passkeys/upload'],
  'integrations/routes.lantern.ts': ['/lantern-people/credentials/upload'],
  'integrations/routes.documents.ts': ['/documents/upload'],
  // The LinkedIn archive, and the export agent's report of the session account's sync.
  'integrations/routes.linkedin.ts': ['/linkedin/upload', '/linkedin/sync/phase'],
  // The Mac app reports THIS machine's sync progress for an account.
  'integrations/routes.accounts.ts': ['/:provider/accounts/:accountId/progress'],
  'upload/routes.ts': ['/'],
  'download-telemetry/routes.ts': ['/'],
  'imessage/routes.ts': ['/queue/pop', '/queue/:id/result'],
  // The Mac registering its attached iPhone, and its mirrored screen frames.
  'phones/routes.ts': ['/register', '/:id/frame/upload'],
};

/**
 * The middleware chain of a route declaration.
 *
 * Scoped to the text between this declaration and the NEXT `router.<verb>(`,
 * then truncated at the handler, so it can never spill into a neighbouring
 * route and produce a false pass. Identifiers are tokenized rather than
 * substring-matched so a comment mentioning a guard's name, or a longer
 * lookalike identifier, cannot satisfy the assertion.
 */
function middlewareIdentifiers(source: string, route: string, at: number): string[] {
  const rest = source.slice(at);
  const nextRoute = rest.slice(1).search(/router\.(get|post|put|patch|delete)\s*\(/);
  const block = nextRoute === -1 ? rest : rest.slice(0, nextRoute + 1);
  const handlerAt = block.search(/asyncHandler\s*\(|\(\s*req\b/);
  const chain = handlerAt === -1 ? block : block.slice(0, handlerAt);
  // Drop comments so a mention of the guard in prose cannot count as applying it.
  const code = chain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(code.includes(route), `internal: route ${route} not inside its own block`);
  return code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

/** Locate every declaration of a route literal, for any HTTP verb or quote style. */
function declarationsOf(source: string, route: string): number[] {
  const literal = new RegExp(
    `router\\.(get|post|put|patch|delete)\\s*\\(\\s*['"\`]${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`,
    'g'
  );
  return [...source.matchAll(literal)].map((m) => m.index!);
}

let guardedCount = 0;
for (const [rel, routes] of Object.entries(MACHINE_DATA_ROUTES)) {
  const source = fs.readFileSync(path.join(domainsDir, rel), 'utf8');
  for (const route of routes) {
    const declarations = declarationsOf(source, route);
    assert.ok(declarations.length > 0, `${rel}: route '${route}' not found — was it renamed?`);
    for (const at of declarations) {
      const identifiers = middlewareIdentifiers(source, route, at);
      assert.ok(
        GUARDS.some((g) => identifiers.includes(g)),
        `${rel} ${route}: machine-data ingest must apply one of ${GUARDS.join(' / ')} — ` +
          `an impersonated session would otherwise write the operator's device data ` +
          `into the viewed account.`
      );
      guardedCount++;
    }
  }
}

// Drift guard: any `*/upload` route ANYWHERE under src/domains must be declared
// above. Scanning the whole tree (not just integrations/) is deliberate —
// POST /api/upload lived in src/domains/upload and was missed by the first
// version of this test precisely because it was directory-scoped.
const declared = new Set(Object.values(MACHINE_DATA_ROUTES).flat());
function* routeFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* routeFiles(full);
    else if (entry.name.endsWith('.ts')) yield full;
  }
}
for (const file of routeFiles(domainsDir)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(
    /router\.(?:post|put|patch)\s*\(\s*['"`]([^'"`]*upload[^'"`]*)['"`]/gi
  )) {
    assert.ok(
      declared.has(match[1]),
      `${path.relative(domainsDir, file)}: ingest route '${match[1]}' is not declared in ` +
        `MACHINE_DATA_ROUTES. Add it (guarded with ${GUARDS[0]}) so containment is enforced.`
    );
  }
}

// Both authentication middlewares must derive the actor from ONE place. When
// only providers/auth.ts read the claim, every hybridAuth route stayed blind and
// rejectImpersonatedUpload silently failed open behind it.
const jwtSource = fs.readFileSync(path.join(backendDir, 'src/providers/supabaseJwt.ts'), 'utf8');
assert.ok(
  /export function impersonatorFromPayload/.test(jwtSource),
  'supabaseJwt.ts must own the single RFC 8693 `act` extraction'
);
for (const middleware of ['auth.ts', 'hybridAuth.ts']) {
  const source = fs.readFileSync(path.join(backendDir, 'src/providers', middleware), 'utf8');
  assert.ok(
    /impersonatedBy: impersonatorFromPayload\(payload\)/.test(source),
    `providers/${middleware} must set user.impersonatedBy via impersonatorFromPayload() — ` +
      `an authentication path that drops the act claim makes every route behind it ` +
      `impersonation-blind and silently defeats rejectImpersonatedUpload.`
  );
}

// The guard must fail closed: no resolved identity => refuse.
const authSource = fs.readFileSync(path.join(backendDir, 'src/providers/auth.ts'), 'utf8');
assert.ok(
  /if \(req\.user === undefined\) \{[\s\S]{0,240}?res\.status\(403\)/.test(authSource),
  'rejectImpersonatedUpload must fail closed when req.user is unset'
);
assert.ok(
  /export const authenticateMachineUpload = \[authenticate, rejectImpersonatedUpload\]/.test(
    authSource
  ),
  'authenticateMachineUpload must compose [authenticate, rejectImpersonatedUpload]'
);

console.log(
  `PASS machine-upload-containment: ${guardedCount} machine-data ingest routes guarded; ` +
    `both auth middlewares derive the act claim from supabaseJwt.impersonatorFromPayload()`
);
