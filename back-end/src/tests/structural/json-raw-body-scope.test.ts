#!/usr/bin/env tsx
/**
 * Structural test: raw request bodies are captured only for signed webhooks.
 *
 *   request ─► scoped webhook parser (verify → req.rawBody) ─► signature check
 *          └► global express.json (no verify) ─────────────────► every other route
 *
 * The global JSON parser accepts large uploads. Copying every body into a
 * second `rawBody` string doubled each upload's memory in the web process.
 * Every source file that reads `rawBody` must be a known signed-webhook
 * consumer whose path is mounted with a scoped raw-capturing parser.
 *
 * Usage: tsx json-raw-body-scope.test.ts [path/to/server.ts]
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname, '../..');
const SERVER_FILE = process.argv[2] ?? path.join(SRC_DIR, 'server.ts');

/** Signed-webhook consumers of req.rawBody → the server.ts mount that must capture it. */
const RAW_BODY_CONSUMERS: Record<string, string> = {
  'domains/integrations/routes.plaid.ts': "'/api/integrations/plaid/webhook'",
  'domains/slack-auto-rca/routes.ts': "'/api/webhooks/slack/auto-rca'",
  'domains/sms-webhook/routes.ts': "'/api/sms'",
  'domains/whatsapp-webhook/routes.ts': "'/api/whatsapp'",
  'domains/purchases/routes.ts': "'/api/purchases/webhooks/agentcard'",
};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const failures: string[] = [];
const server = fs.readFileSync(SERVER_FILE, 'utf-8');

// 1. The global parser (app.use(express.json(...)) with no path) must not capture raw bodies.
const globalParsers = [...server.matchAll(/app\.use\(\s*express\.json\(/g)];
if (globalParsers.length === 0) failures.push('server.ts: no global express.json parser found');
for (const match of globalParsers) {
  let depth = 0;
  let end = match.index;
  for (let i = match.index; i < server.length; i++) {
    if (server[i] === '(') depth++;
    if (server[i] === ')') depth--;
    if (depth === 0 && server[i] === ')') {
      end = i;
      break;
    }
  }
  if (/verify\s*:/.test(server.slice(match.index, end))) {
    failures.push('server.ts: the global express.json parser copies every body into req.rawBody');
  }
}

// 2. Every rawBody reader is a known signed webhook mounted behind a scoped parser.
for (const file of sourceFiles(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
  if (
    rel === 'server.ts' ||
    !/\breq\b[^;\n]*\.rawBody\b|\)\.rawBody\b/.test(fs.readFileSync(file, 'utf-8'))
  ) {
    continue;
  }
  const mount = RAW_BODY_CONSUMERS[rel];
  if (mount === undefined) {
    failures.push(
      `${rel} reads req.rawBody but has no scoped raw-capturing parser registered here`
    );
    continue;
  }
  const mountAt = server.indexOf(mount);
  const globalAt = globalParsers[0]?.index ?? -1;
  if (mountAt < 0 || (globalAt >= 0 && mountAt > globalAt)) {
    failures.push(
      `${rel}: ${mount} must be mounted with a raw-capturing parser before the global parser`
    );
  }
}

if (failures.length > 0) {
  console.error('json-raw-body-scope: FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('json-raw-body-scope: PASS');
