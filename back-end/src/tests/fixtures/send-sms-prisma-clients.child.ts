#!/usr/bin/env tsx
// Child of send-sms.blackbox.ts. Loads every module the send-sms domain imports, in its import
// order, with PrismaClient construction counted, and reports where each client was constructed.
// The library engine's first connect setenv()s SSL_CERT_FILE/SSL_CERT_DIR on an engine thread,
// while any client constructed before that connect reads process.env during its asynchronous
// library load (glibc getenv/setenv race: the domain process dies with SIGSEGV and no output).
// So the domain must start its first query with exactly one client constructed. Mode `control`
// constructs one extra client after loading, to prove the counter sees every construction.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { PrismaClient } from '@prisma/client';

const load = createRequire(__filename);
// The CommonJS exports object every importer reads PrismaClient from at construction time.
const runtime = load('@prisma/client') as { PrismaClient: typeof PrismaClient };
const Base = runtime.PrismaClient;
const sites: string[] = [];

runtime.PrismaClient = class CountedPrismaClient extends Base {
  constructor(...args: ConstructorParameters<typeof PrismaClient>) {
    super(...args);
    const frame = (new Error().stack ?? '')
      .split('\n')
      .slice(2)
      .find((line) => line.includes('/src/'));
    sites.push(frame?.trim() ?? 'unknown');
  }
} as typeof PrismaClient;

const domainDir = resolve(__dirname, '../blackbox');
const domain = readFileSync(resolve(domainDir, 'send-sms.blackbox.ts'), 'utf8');
const specifiers = [
  ...domain.matchAll(/^} from '(\.{1,2}\/[^']+)';$|^import .* from '(\.{1,2}\/[^']+)';$/gm),
].map((match) => match[1] ?? match[2]);
if (specifiers.length === 0) throw new Error('send-sms.blackbox.ts: no relative imports found');
for (const specifier of specifiers) load(resolve(domainDir, specifier));
if (process.argv[2] === 'control') new runtime.PrismaClient();

// Exit once the report is flushed: the started engine loads must not hold the process open.
process.stdout.write(`${JSON.stringify({ modules: specifiers, sites })}\n`, () => process.exit(0));
